// Unified non-streaming conversion pipeline: detect the client format from
// path+body, resolve the model route (aliases included), resolve the upstream
// key BEFORE conversion so o2a2o_keys never enters any converter, convert
// through the IR only when source and target providers differ (same-provider
// bodies pass through untouched), forward, then render the upstream response
// back in the client's own format.
import type { AppConfig } from "../config/loader";
import type { Provider } from "./forwarder";
import { resolveKey, forwardToUpstream } from "./forwarder";
import { detectFormat } from "./format-detector";
import { ParamError, chatToIr, irToChat, chatResponseToIr, irToChatResponse } from "../converters/chat";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../converters/anthropic";
import { responsesToIr, irToResponsesResponse } from "../converters/responses";

export interface GatewayOutcome {
  status: number;
  body: Record<string, unknown>;
  droppedParams?: string[];        // -> x-o2a2o-dropped header
}

const FORMAT_PROVIDER: Record<"openai_chat" | "openai_responses" | "anthropic", Provider> = {
  openai_chat: "openai", openai_responses: "openai", anthropic: "anthropic",
};

const TO_IR = { openai_chat: chatToIr, openai_responses: responsesToIr, anthropic: anthropicToIr };
const FROM_IR = { openai: irToChat, anthropic: irToAnthropic };

export async function handleGatewayRequest(
  cfg: AppConfig,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): Promise<GatewayOutcome> {
  const format = detectFormat(path, body);
  const requested = cfg.aliases[body.model as string] ?? body.model;
  const model = cfg.models.find((m) => m.name === requested);
  if (!model) throw new ParamError(`no route configured for model: ${String(body.model)}`);
  const targetProvider = model.provider;
  const sourceProvider = FORMAT_PROVIDER[format];

  // key resolution happens BEFORE conversion so o2a2o_keys never enters any converter
  const { key, body: cleanBody } = resolveKey(cfg, targetProvider, headers, body);

  let upstreamBody: Record<string, unknown>;
  let dropped: string[] | undefined;
  if (targetProvider === sourceProvider) {
    upstreamBody = cleanBody;                                   // passthrough, zero conversion
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

  if (format === "anthropic" && targetProvider === "anthropic") return { status: 200, body: upstreamJson, droppedParams: dropped };
  if (targetProvider === "anthropic") {
    const ir = anthropicResponseToIr(upstreamJson);
    return { status: 200, body: format === "openai_responses" ? irToResponsesResponse(ir) : irToChatResponse(ir), droppedParams: dropped };
  }
  if (format === "anthropic") {
    const ir = chatResponseToIr(upstreamJson);
    return { status: 200, body: irToAnthropicResponse(ir), droppedParams: dropped };
  }
  return { status: 200, body: upstreamJson, droppedParams: dropped };   // openai<->openai passthrough
}
