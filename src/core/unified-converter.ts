// Unified gateway pipeline: detect the client format from path+body, resolve
// the model route (aliases included), resolve the upstream key BEFORE
// conversion so o2a2o_keys never enters any converter, convert through the IR
// only when source and target providers differ (same-provider bodies pass
// through untouched with the alias rewritten to the canonical model name),
// forward, then render the upstream response in the requested output format
// (FR-2: client format by default, x-o2a2o-output-format override supported).
// The detect/alias/model/key/request-conversion prefix is shared verbatim by
// the non-stream path (handleGatewayRequest) and the streaming path
// (handleGatewayStream, M2).
import type { AppConfig, ModelConfig } from "../config/loader";
import { resolveTimeoutConfig } from "../config/loader";
import type { Provider } from "./forwarder";
import type { InputFormat } from "./format-detector";
import { resolveKey, forwardToUpstream } from "./forwarder";
import { calculateTimeout, latencyTracker } from "./timeout-calculator";
import { detectFormat } from "./format-detector";
import { warn } from "../utils/logger";
import type { IRResponse } from "../types/ir";
import { ParamError, chatToIr, irToChat, chatResponseToIr, irToChatResponse } from "../converters/chat";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../converters/anthropic";
import { responsesToIr, irToResponsesResponse, responsesResponseToIr } from "../converters/responses";
import { StreamTimeoutManager } from "./stream-timeout-manager";
import { pipeThrough, convertStream } from "./stream-converter";
import { AnthropicStreamEncoder } from "../converters/stream-anthropic";
import { ChatStreamEncoder } from "../converters/stream-chat";
import { ResponsesStreamEncoder } from "../converters/stream-responses";

export interface GatewayOutcome {
  status: number;
  body: Record<string, unknown>;
  droppedParams?: string[];        // -> x-o2a2o-dropped header
}

export interface GatewayStreamOutcome {
  status: number;
  stream: ReadableStream<Uint8Array>;
  contentType: "text/event-stream";
  droppedParams?: string[];        // -> x-o2a2o-dropped header
}

const FORMAT_PROVIDER: Record<InputFormat, Provider> = {
  openai_chat: "openai", openai_responses: "openai", anthropic: "anthropic",
};

const TO_IR = { openai_chat: chatToIr, openai_responses: responsesToIr, anthropic: anthropicToIr };
const FROM_IR = { openai: irToChat, anthropic: irToAnthropic };

// FR-2 response matrix: the upstream natively returns the shape of the endpoint
// the request was sent to (`nativeFormat`). The response is passed through raw
// only when the requested output format equals that shape; otherwise upstream
// JSON is converted upstream->IR->output-format.
const RESPONSE_TO_IR: Record<InputFormat, (res: unknown) => IRResponse> = {
  openai_chat: chatResponseToIr, openai_responses: responsesResponseToIr, anthropic: anthropicResponseToIr,
};
const RESPONSE_FROM_IR: Record<InputFormat, (ir: IRResponse) => Record<string, unknown>> = {
  openai_chat: irToChatResponse, openai_responses: irToResponsesResponse, anthropic: irToAnthropicResponse,
};

const OUTPUT_FORMATS: readonly string[] = ["openai_chat", "openai_responses", "anthropic"];

// Stream-truthiness rule (backlog): the three spellings clients actually send
// select the streaming path; anything else is a non-stream request.
export function wantsStreaming(body: Record<string, unknown>): boolean {
  return body.stream === true || body.stream === "true" || body.stream === 1;
}

interface ResolvedRoute {
  format: InputFormat;             // client (source) format
  outFormat: InputFormat;          // requested output format (header override aware)
  targetProvider: Provider;
  model: ModelConfig;
  key: string;
  upstreamBody: Record<string, unknown>;
  dropped: string[] | undefined;
  endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
}

// Shared first half of both gateway paths: detect, output-format override
// validation, alias + model resolution, key resolution, request conversion.
// `wantsStream` normalizes the body's stream flag to a real boolean so an SSE
// upstream always receives stream:true regardless of how the client spelled it
// or whether the converters carry the field.
function resolveRoute(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
  wantsStream: boolean,
): ResolvedRoute {
  const normalized = wantsStream ? { ...body, stream: true } : body;
  const format = detectFormat(path, normalized);
  // FR-2: per-request response format override; validated before any work.
  const headerFormat = headers["x-o2a2o-output-format"];
  if (headerFormat !== undefined && !OUTPUT_FORMATS.includes(headerFormat))
    throw new ParamError(`unsupported x-o2a2o-output-format: ${headerFormat}`);
  const outFormat: InputFormat = (headerFormat as InputFormat | undefined) ?? format;
  const requested = cfg.aliases[normalized.model as string] ?? normalized.model;
  const model = cfg.models.find((m) => m.name === requested);
  if (!model) throw new ParamError(`no route configured for model: ${String(normalized.model)}`);
  const targetProvider = model.provider;
  const sourceProvider = FORMAT_PROVIDER[format];

  // key resolution happens BEFORE conversion so o2a2o_keys never enters any converter
  const { key, body: cleanBody } = resolveKey(cfg, model, headers, normalized);

  let upstreamBody: Record<string, unknown>;
  let dropped: string[] | undefined;
  if (targetProvider === sourceProvider) {
    upstreamBody = { ...cleanBody, model: model.name };          // passthrough; alias -> canonical name
  } else {
    const conv = TO_IR[format](cleanBody);                       // { ir, dropped } | throws ParamError
    dropped = conv.dropped.length ? conv.dropped : undefined;
    const ir = { ...conv.ir, model: model.name };
    upstreamBody = FROM_IR[targetProvider](ir);                  // irToChat | irToAnthropic
  }
  if (wantsStream) upstreamBody = { ...upstreamBody, stream: true };
  const endpoint = targetProvider === "anthropic" ? "/v1/messages"
    : (format === "openai_responses" && targetProvider === "openai") ? "/v1/responses"
    : "/v1/chat/completions";
  // note: cross-provider to openai always targets /v1/chat/completions
  // (responses-target conversion from anthropic source is format-level, not provider-level)

  return { format, outFormat, targetProvider, model, key, upstreamBody, dropped, endpoint };
}

// The wire shape the upstream natively produces for the endpoint chosen by
// resolveRoute. Serves both the non-stream response conversion and the
// streaming path's source-format choice.
function nativeFormatOf(targetProvider: Provider, format: InputFormat): InputFormat {
  return targetProvider === "anthropic"
    ? "anthropic"
    : format === "openai_responses" ? "openai_responses" : "openai_chat";
}

export async function handleGatewayRequest(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<GatewayOutcome> {
  const { format, outFormat, targetProvider, model, key, upstreamBody, dropped, endpoint } =
    resolveRoute(cfg, path, body, headers, wantsStreaming(body));

  // Dynamic non-stream timeout (spec §8.1): estimate from the client body's
  // token limit, then feed the observed upstream latency back into the tracker.
  const rawMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  const timeoutMs = calculateTimeout({
    model: model.name,
    maxTokens: typeof rawMaxTokens === "number" ? rawMaxTokens : 0,
    isStream: body.stream === true,
    tc: resolveTimeoutConfig(cfg),
  });
  const start = Date.now();
  const upstreamRes = await forwardToUpstream({ provider: targetProvider, endpoint, body: upstreamBody, key, timeoutMs });
  latencyTracker.record(model.name, Date.now() - start);
  const upstreamJson = await upstreamRes.json() as Record<string, unknown>;

  const nativeFormat = nativeFormatOf(targetProvider, format);

  if (dropped?.length) warn(`dropped unsupported params: ${dropped.join(",")}`);
  if (outFormat === nativeFormat) return { status: 200, body: upstreamJson, droppedParams: dropped };
  return {
    status: 200,
    body: RESPONSE_FROM_IR[outFormat](RESPONSE_TO_IR[nativeFormat](upstreamJson)),
    droppedParams: dropped,
  };
}

// One error frame in the destination format. A fresh encoder is used on
// purpose: mid-stream error frames are standalone (no envelope, no finish
// frames after an error), so no accumulated encoder state is needed.
function errorFrame(dstFormat: InputFormat, message: string): string {
  if (dstFormat === "anthropic") {
    const enc = new AnthropicStreamEncoder();
    return enc.push({ type: "error", message });
  }
  if (dstFormat === "openai_responses") {
    const enc = new ResponsesStreamEncoder();
    return enc.push({ type: "error", message });
  }
  const enc = new ChatStreamEncoder();
  return enc.push({ type: "error", message });
}

// Arms the timeout monitor around the converted stream so the timeout
// contract holds even while a read from the upstream is in flight: on fire,
// the target-format error frame is enqueued and the stream closed. Late
// upstream data after the error frame is dropped and the upstream body is
// cancelled. The monitor itself disarms on every other terminal path (source
// close / source error / downstream cancel), so this wrapper only owns the
// timeout path.
function withTimeoutGuard(
  inner: ReadableStream<Uint8Array>,
  monitor: StreamTimeoutManager,
  dstFormat: InputFormat,
): ReadableStream<Uint8Array> {
  const reader = inner.getReader();
  const output = new TextEncoder();
  let timedOut = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      monitor.arm((err) => {
        timedOut = true;
        try { controller.enqueue(output.encode(errorFrame(dstFormat, err.message))); } catch { /* already closed */ }
        try { controller.close(); } catch { /* already closed */ }
        void reader.cancel().catch(() => {});
      });
    },
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        monitor.disarm();
        controller.error(e);
        return;
      }
      if (timedOut) return;              // client already holds the error frame + close
      if (chunk.done) { controller.close(); return; }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      monitor.disarm();
      return inner.cancel(reason);
    },
  });
}

// Streaming main path (M2): the same first half as the non-stream path, then
// the upstream is called with stream:true and Accept SSE. Its byte stream is
// piped through verbatim when source and output formats match, otherwise
// converted through the StreamEvent hub. Upstream non-2xx throws before any
// bytes reach the client, so server.ts renders it through the M1 error path;
// stream-timeout errors are encoded as a target-format error frame and the
// stream closes right after it.
export async function handleGatewayStream(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<GatewayStreamOutcome | GatewayOutcome> {
  const { format, outFormat, targetProvider, model, key, upstreamBody, dropped, endpoint } =
    resolveRoute(cfg, path, body, headers, wantsStreaming(body));
  if (dropped?.length) warn(`dropped unsupported params: ${dropped.join(",")}`);

  // Streams carry no token estimate; by_model overrides and the latency
  // feedback still bound the time to upstream response headers.
  const timeoutMs = calculateTimeout({ model: model.name, maxTokens: 0, isStream: true, tc: resolveTimeoutConfig(cfg) });
  const upstreamRes = await forwardToUpstream({
    provider: targetProvider, endpoint, body: upstreamBody, key, timeoutMs, accept: "text/event-stream",
  });
  const source = upstreamRes.body;
  if (!source) throw new Error("upstream returned an empty body for a streaming request");

  const srcFormat = nativeFormatOf(targetProvider, format);
  const monitor = new StreamTimeoutManager(resolveTimeoutConfig(cfg).stream);
  const inner = srcFormat === outFormat
    ? pipeThrough(source, monitor)
    : convertStream({
        srcFormat,
        dstFormat: outFormat,
        source,
        monitor,
        chatMeta: { id: `chatcmpl-${crypto.randomUUID()}`, model: model.name },
      });
  return {
    status: 200,
    stream: withTimeoutGuard(inner, monitor, outFormat),
    contentType: "text/event-stream",
    droppedParams: dropped,
  };
}
