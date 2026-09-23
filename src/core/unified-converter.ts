// Unified gateway pipeline: detect the client format from path+body, resolve
// the model route (aliases included), resolve the dynamic upstream key BEFORE
// conversion so o2a2o_keys never enters any converter (a dynamic key is used
// per-request with no pool accounting; otherwise the model's key pool chooses
// at forward time, M3), convert through the IR only when source and target
// providers differ (same-provider bodies pass through untouched with the alias
// rewritten to the canonical model name), forward, then render the upstream
// response in the requested output format (FR-2: client format by default,
// x-o2a2o-output-format override supported).
// The detect/alias/model/key/request-conversion prefix is shared verbatim by
// the non-stream path (handleGatewayRequest) and the streaming path
// (handleGatewayStream, M2).
import type { AppConfig, ModelConfig, TimeoutConfig } from "../config/loader";
import { resolveTimeoutConfig, resolveFailoverConfig } from "../config/loader";
import type { Provider } from "./forwarder";
import type { InputFormat } from "./format-detector";
import { forwardToUpstream, forwardWithFailover, KeyPoolRegistry, isRetryableUpstreamError } from "./forwarder";
import { calculateTimeout, latencyTracker } from "./timeout-calculator";
import { detectFormat } from "./format-detector";
import { warn } from "../utils/logger";
import type { IRRequest, IRResponse } from "../types/ir";
import { ParamError, chatToIr, irToChat, chatResponseToIr, irToChatResponse } from "../converters/chat";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../converters/anthropic";
import { responsesToIr, irToResponsesResponse, responsesResponseToIr } from "../converters/responses";
import { StreamTimeoutManager, StreamTimeoutError } from "./stream-timeout-manager";
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
// Both request converters accept an optional `dropped` collector for parts
// they must skip during outbound conversion (irToChat never pushes to it).
const FROM_IR: Record<Provider, (ir: IRRequest, dropped?: string[]) => Record<string, unknown>> = {
  openai: irToChat, anthropic: irToAnthropic,
};

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
  dynamicKey: string | undefined;  // header/body key; present => single per-request attempt bypassing the pool
  upstreamBody: Record<string, unknown>;
  dropped: string[] | undefined;
  endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
}

// Shared first half of both gateway paths: detect, output-format override
// validation, alias + model resolution, dynamic-key extraction, request
// conversion. `wantsStream` normalizes the body's stream flag to a real
// boolean so an SSE upstream always receives stream:true regardless of how the
// client spelled it or whether the converters carry the field.
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

  // Dynamic key extraction happens BEFORE conversion so o2a2o_keys never
  // enters any converter. The field is stripped ALWAYS, even when the key came
  // from elsewhere; configured keys are not chosen here anymore — the model's
  // pool owns that decision at forward time (M3).
  const hdrKey = headers[model.provider === "openai" ? "x-o2a2o-openai-key" : "x-o2a2o-anthropic-key"];
  const { o2a2o_keys, ...cleanBody } = normalized; // strip ALWAYS, even when key came from elsewhere
  const bodyKey = (o2a2o_keys as Partial<Record<Provider, string>> | undefined)?.[model.provider];
  const dynamicKey = hdrKey || bodyKey || undefined; // empty strings count as absent (M2 truthiness)

  let upstreamBody: Record<string, unknown>;
  let dropped: string[] | undefined;
  if (targetProvider === sourceProvider) {
    upstreamBody = { ...cleanBody, model: model.name };          // passthrough; alias -> canonical name
  } else {
    const conv = TO_IR[format](cleanBody);                       // { ir, dropped } | throws ParamError
    dropped = conv.dropped.length ? conv.dropped : undefined;
    const ir = { ...conv.ir, model: model.name };
    const outboundDropped: string[] = [];
    upstreamBody = FROM_IR[targetProvider](ir, outboundDropped); // irToChat | irToAnthropic
    if (outboundDropped.length) dropped = [...(dropped ?? []), ...outboundDropped];
  }
  if (wantsStream) upstreamBody = { ...upstreamBody, stream: true };
  const endpoint = targetProvider === "anthropic" ? "/v1/messages"
    : (format === "openai_responses" && targetProvider === "openai") ? "/v1/responses"
    : "/v1/chat/completions";
  // note: cross-provider to openai always targets /v1/chat/completions
  // (responses-target conversion from anthropic source is format-level, not provider-level)

  return { format, outFormat, targetProvider, model, dynamicKey, upstreamBody, dropped, endpoint };
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
  signal?: AbortSignal,
): Promise<GatewayOutcome> {
  const { format, outFormat, targetProvider, model, dynamicKey, upstreamBody, dropped, endpoint } =
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
  // A dynamic key makes a single per-request attempt with no pool accounting;
  // otherwise the model's pool picks per attempt and failover runs on retryable
  // errors (M3). The model-level latency record feeds TimeoutCalculator either way.
  // The client signal (live-test hardening Task 1) cancels the in-flight
  // upstream fetch on disconnect; a client abort never retries or records.
  const upstreamRes = dynamicKey
    ? await forwardToUpstream({ provider: targetProvider, endpoint, body: upstreamBody, key: dynamicKey, timeoutMs, signal, baseUrl: model.base_url })
    : (await forwardWithFailover({
        provider: targetProvider, endpoint, body: upstreamBody,
        registry: KeyPoolRegistry.from(cfg), model, timeoutMs,
        maxRetries: resolveFailoverConfig(cfg).max_retries, signal, baseUrl: model.base_url,
      })).response;
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

// One stream-establishment attempt (M3): send the SSE request, wire the M2
// conversion pipeline (a fresh StreamTimeoutManager and fresh converters per
// attempt), then race the upstream's first output byte against the
// first_packet budget. The monitor's single fire callback serves both phases:
// before the first byte (no client stream exists yet) it cancels the
// half-open upstream stream and fails the attempt, letting the caller retry
// on the pool's next key; after the first byte it keeps the M2 semantics —
// the target-format error frame is enqueued, the stream closed and late
// upstream data dropped. The already-read first chunk is delivered by the
// returned stream first; nothing beyond it is buffered, and losing attempts
// never produce a client stream at all (zero-byte guarantee).
async function establishUpstreamStream(opts: {
  provider: Provider;
  endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
  body: Record<string, unknown>;
  key: string;
  timeoutMs: number;
  srcFormat: InputFormat;
  dstFormat: InputFormat;
  meta: { id: string; model: string };
  timeouts: TimeoutConfig["stream"];
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<{ kind: "ok"; stream: ReadableStream<Uint8Array> } | { kind: "fail"; error: unknown }> {
  let upstreamRes: Response;
  try {
    upstreamRes = await forwardToUpstream({
      provider: opts.provider, endpoint: opts.endpoint, body: opts.body,
      key: opts.key, timeoutMs: opts.timeoutMs, accept: "text/event-stream",
      signal: opts.signal, baseUrl: opts.baseUrl,
    });
  } catch (e) {
    return { kind: "fail", error: e };   // headers phase: UpstreamError, network failures, client aborts, ...
  }
  const source = upstreamRes.body;
  if (!source) return { kind: "fail", error: new Error("upstream returned an empty body for a streaming request") };

  const monitor = new StreamTimeoutManager(opts.timeouts);
  const inner = opts.srcFormat === opts.dstFormat
    ? pipeThrough(source, monitor)
    : convertStream({
        srcFormat: opts.srcFormat,
        dstFormat: opts.dstFormat,
        source,
        monitor,
        meta: opts.meta,
      });

  const reader = inner.getReader();
  const output = new TextEncoder();
  let timedOut = false;
  let aborted = false;
  let outController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let failure: StreamTimeoutError | undefined;
  let first: Awaited<ReturnType<typeof reader.read>> | undefined;
  let readError: unknown;
  let wake: () => void = () => {};
  const settled = new Promise<void>((resolve) => { wake = resolve; });

  // Client-disconnect wiring (live-test hardening Task 1): the request signal
  // tears the attempt down in either phase. Pre-first-byte: cancel the inner
  // reader and wake the establishment race — the caller sees the aborted
  // signal and terminates the whole request (no retry, no accounting, no
  // error frame; the client is gone). Post-first-byte: disarm the monitor,
  // cancel the conversion-chain reader (which propagates to the upstream
  // body) and close the client stream safely. The {once:true} listener is
  // removed on every non-abort exit path (monitor fire, pull done, pull
  // error, downstream cancel).
  const onAbort = () => {
    aborted = true;
    monitor.disarm();
    void reader.cancel().catch(() => {});
    try { outController?.close(); } catch { /* already closed */ }
    wake();
  };
  const removeAbortListener = () => opts.signal?.removeEventListener("abort", onAbort);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  monitor.arm((err) => {
    removeAbortListener();
    if (outController) {
      // Post-first-byte fire (idle/total, D5): the client holds the error
      // frame and the close; late upstream data is dropped.
      timedOut = true;
      try { outController.enqueue(output.encode(errorFrame(opts.dstFormat, err.message))); } catch { /* already closed */ }
      try { outController.close(); } catch { /* already closed */ }
    } else {
      // Pre-first-byte fire: nothing reached the client. Drop the half-open
      // stream; the establishment loop records the failure and retries.
      failure = err;
    }
    void reader.cancel().catch(() => {});
    wake();
  });

  void (async () => {
    try { first = await reader.read(); } catch (e) { readError = e; }
    wake();
  })();
  await settled;
  if (failure) { removeAbortListener(); return { kind: "fail", error: failure }; }
  if (readError !== undefined) { removeAbortListener(); return { kind: "fail", error: readError }; }

  let pending = first;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { outController = controller; },
    async pull(controller) {
      let chunk = pending;
      pending = undefined;
      if (!chunk) {
        try {
          chunk = await reader.read();
        } catch (e) {
          removeAbortListener();
          monitor.disarm();
          controller.error(e);
          return;
        }
      }
      // timedOut: the client already holds the error frame + close.
      // aborted: onAbort closed this controller; a pull that was in flight
      // when the abort fired must not touch the closed controller again.
      if (timedOut || aborted) return;
      if (chunk.done) { removeAbortListener(); controller.close(); return; }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      removeAbortListener();
      monitor.disarm();
      return reader.cancel(reason);
    },
  });
  return { kind: "ok", stream };
}

// Envelope metadata for a converted stream: the resolved model name plus a
// destination-format-prefixed request id, so converted frames carry real
// values instead of the encoders' synthesized defaults.
function streamMeta(outFormat: InputFormat, model: string): { id: string; model: string } {
  const prefix = outFormat === "anthropic" ? "msg_" : outFormat === "openai_responses" ? "resp_" : "chatcmpl-";
  return { id: prefix + crypto.randomUUID(), model };
}

// Exhaustion before the first byte: the client's SSE response closes after a
// single target-format error frame; no finish frames follow an error (the
// codecs' contract, same as mid-stream errors).
function errorFrameStream(dstFormat: InputFormat, message: string): ReadableStream<Uint8Array> {
  const frame = errorFrame(dstFormat, message);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
}

// Streaming main path (M2, M3 Task 4): the same first half as the non-stream
// path, then stream establishment runs as a pre-first-packet failover loop —
// the retry window closes when the winning upstream delivers its first byte.
// Headers-phase failures classify exactly like the non-stream loop (D4); a
// first_packet timeout fires while the client has received zero bytes, so the
// half-open stream is dropped and establishment re-runs on the pool's next
// key (fresh manager + fresh stream). After the first byte everything is M2
// semantics (D5): idle/total timeouts and mid-stream errors surface in-band
// and never switch keys. During retries nothing is buffered and no client
// stream exists yet, so the zero-byte guarantee holds by construction.
// Exhaustion renders a single first_packet error frame + close (M2 encoding
// path); every other terminal failure throws into the M1 error path, which
// renders UpstreamError as a JSON error response.
// A client disconnect (live-test hardening Task 1) terminates the whole
// request at any point in the loop: no retry, no key accounting, no error
// frame — the outcome is an empty, immediately-closed stream.
export async function handleGatewayStream(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<GatewayStreamOutcome | GatewayOutcome> {
  const { format, outFormat, targetProvider, model, dynamicKey, upstreamBody, dropped, endpoint } =
    resolveRoute(cfg, path, body, headers, wantsStreaming(body));
  if (dropped?.length) warn(`dropped unsupported params: ${dropped.join(",")}`);

  // A disconnected client gets an empty, immediately-closed SSE stream: no
  // error frame (nothing renders for a client that is gone), no retry, no key
  // accounting (a client disconnect is not an upstream fault).
  const emptyClosedStream = (): GatewayStreamOutcome => ({
    status: 200,
    stream: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    contentType: "text/event-stream",
    droppedParams: dropped,
  });

  // Streams carry no token estimate; by_model overrides and the latency
  // feedback still bound the time to upstream response headers.
  const timeoutMs = calculateTimeout({ model: model.name, maxTokens: 0, isStream: true, tc: resolveTimeoutConfig(cfg) });
  const srcFormat = nativeFormatOf(targetProvider, format);
  // A dynamic key makes a single per-request attempt with no pool interaction
  // (non-stream mirror); configured keys establish through the pool's
  // pre-first-packet failover loop. poolFor throws when neither model keys nor
  // a provider-wide key exist (M2 semantics).
  const pool = dynamicKey ? undefined : KeyPoolRegistry.from(cfg).poolFor(model);
  const attempts = dynamicKey ? 1 : Math.max(1, resolveFailoverConfig(cfg).max_retries);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return emptyClosedStream();
    pool?.maybeRecover();
    const decision = pool ? pool.select() : undefined;
    const start = Date.now();
    const established = await establishUpstreamStream({
      provider: targetProvider, endpoint, body: upstreamBody,
      key: decision ? decision.key : dynamicKey as string,
      timeoutMs,
      srcFormat,
      dstFormat: outFormat,
      meta: streamMeta(outFormat, model.name),
      timeouts: resolveTimeoutConfig(cfg).stream,
      signal,
      baseUrl: model.base_url,
    });
    // A disconnect during establishment wins over every attempt outcome: the
    // whole request terminates before any retry or accounting decision.
    if (signal?.aborted) return emptyClosedStream();
    if (established.kind === "ok") {
      // The winning key's first-packet latency feeds its own scoring samples;
      // the model-level latencyTracker stays non-stream-only so stream TTFB
      // cannot poison the adaptive floor (M2 ruling).
      if (pool && decision) pool.recordSuccess(decision.keyId, Date.now() - start);
      return {
        status: 200,
        stream: established.stream,
        contentType: "text/event-stream",
        droppedParams: dropped,
      };
    }
    lastError = established.error;
    // Key-level failures demote the key and switch (network/timeout/5xx/429/
    // 401/403, plus the pre-first-byte first_packet timeout); request-level
    // failures surface immediately without recording (D4, non-stream mirror).
    const retryable = lastError instanceof StreamTimeoutError
      ? lastError.retryable
      : isRetryableUpstreamError(lastError);
    if (!retryable) break;
    if (pool && decision) pool.recordFailure(decision.keyId);
  }
  // Retries exhausted (or a terminal request-level failure): a first_packet
  // timeout renders as one in-band target-format error frame + close (the
  // client has seen no data, so nothing is duplicated); anything else keeps
  // the M2 throw-into-the-error-path semantics.
  if (lastError instanceof StreamTimeoutError && lastError.stage === "first_packet") {
    return {
      status: 200,
      stream: errorFrameStream(outFormat, lastError.message),
      contentType: "text/event-stream",
      droppedParams: dropped,
    };
  }
  throw lastError;
}
