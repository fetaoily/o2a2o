// Unified non-streaming conversion pipeline: detect the client format from
// path+body, resolve the model route (aliases included), resolve the upstream
// key BEFORE conversion so o2a2o_keys never enters any converter, convert
// through the IR only when source and target providers differ (same-provider
// bodies pass through untouched with the alias rewritten to the canonical
// model name), forward, then render the upstream response in the requested
// output format (FR-2: client format by default, x-o2a2o-output-format
// override supported).
import type { AppConfig } from "../config/loader";
import type { Provider } from "./forwarder";
import type { InputFormat } from "./format-detector";
import { resolveKey, forwardToUpstream } from "./forwarder";
import { detectFormat } from "./format-detector";
import { warn } from "../utils/logger";
import type { IRResponse } from "../types/ir";
import { ParamError, chatToIr, irToChat, chatResponseToIr, irToChatResponse } from "../converters/chat";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../converters/anthropic";
import { responsesToIr, irToResponsesResponse, responsesResponseToIr } from "../converters/responses";

export interface GatewayOutcome {
  status: number;
  body: Record<string, unknown>;
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

export async function handleGatewayRequest(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<GatewayOutcome> {
  const format = detectFormat(path, body);
  // FR-2: per-request response format override; validated before any work.
  const headerFormat = headers["x-o2a2o-output-format"];
  if (headerFormat !== undefined && !OUTPUT_FORMATS.includes(headerFormat))
    throw new ParamError(`unsupported x-o2a2o-output-format: ${headerFormat}`);
  const outFormat: InputFormat = (headerFormat as InputFormat | undefined) ?? format;
  const requested = cfg.aliases[body.model as string] ?? body.model;
  const model = cfg.models.find((m) => m.name === requested);
  if (!model) throw new ParamError(`no route configured for model: ${String(body.model)}`);
  const targetProvider = model.provider;
  const sourceProvider = FORMAT_PROVIDER[format];

  // key resolution happens BEFORE conversion so o2a2o_keys never enters any converter
  const { key, body: cleanBody } = resolveKey(cfg, model, headers, body);

  let upstreamBody: Record<string, unknown>;
  let dropped: string[] | undefined;
  if (targetProvider === sourceProvider) {
    if (cleanBody.stream === true)
      throw new ParamError("streaming is not supported in this gateway version (planned for M2)");
    upstreamBody = { ...cleanBody, model: model.name };          // passthrough; alias -> canonical name
  } else {
    const conv = TO_IR[format](cleanBody);                       // { ir, dropped } | throws ParamError
    dropped = conv.dropped.length ? conv.dropped : undefined;
    const ir = { ...conv.ir, model: model.name };
    upstreamBody = FROM_IR[targetProvider](ir);                  // irToChat | irToAnthropic
  }
  const endpoint = targetProvider === "anthropic" ? "/v1/messages"
    : (format === "openai_responses" && targetProvider === "openai") ? "/v1/responses"
    : "/v1/chat/completions";
  // note: cross-provider to openai always targets /v1/chat/completions in M1
  // (responses-target conversion from anthropic source is format-level, not provider-level)

  const upstreamRes = await forwardToUpstream({ provider: targetProvider, endpoint, body: upstreamBody, key });
  const upstreamJson = await upstreamRes.json() as Record<string, unknown>;

  // The shape the upstream natively returned, given the endpoint chosen above.
  const nativeFormat: InputFormat = targetProvider === "anthropic"
    ? "anthropic"
    : format === "openai_responses" ? "openai_responses" : "openai_chat";

  if (dropped?.length) warn(`dropped unsupported params: ${dropped.join(",")}`);
  if (outFormat === nativeFormat) return { status: 200, body: upstreamJson, droppedParams: dropped };
  return {
    status: 200,
    body: RESPONSE_FROM_IR[outFormat](RESPONSE_TO_IR[nativeFormat](upstreamJson)),
    droppedParams: dropped,
  };
}
