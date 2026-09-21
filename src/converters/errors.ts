// Cross-format error body mapping: every client receives errors in the error
// structure of its own protocol (TECH-DESIGN §15.8). `err` is either a
// gateway-internal Error (ParamError -> always 400) or an upstream failure
// { upstream: number, body: <upstream error JSON> } whose error type is
// translated into the client format per the mapping table.
import type { InputFormat } from "../core/format-detector";
import { ParamError } from "./chat";

export interface ClientError { status: number; body: Record<string, unknown> }

// OpenAI upstream type -> anthropic error type.
function toAnthropicType(upstream: number, type: string | undefined): string {
  if (upstream === 429 || type?.includes("rate")) return "rate_limit_error";
  if (type?.includes("authentication")) return "authentication_error";
  if (upstream >= 500) return "api_error";
  return "invalid_request_error";
}

// Anthropic upstream type -> openai error type (reverse table).
function toOpenAIType(upstream: number, type: string | undefined): string {
  if (upstream === 429 || type?.includes("rate")) return "rate_limit_error";
  if (type?.includes("authentication")) return "authentication_error";
  if (type === "overloaded_error" || upstream >= 500) return "api_error";
  return "invalid_request_error";
}

function requestId(): string {
  return "req_" + crypto.randomUUID();
}

// Upstream anthropic bodies carry { type: "error", error: { type, message } };
// anything else with an `error` object is openai-shaped.
function isAnthropicBody(b: Record<string, unknown>): boolean {
  return b.type === "error";
}

export function toClientError(status: number, err: unknown, clientFormat: InputFormat): ClientError {
  // Gateway-internal error: build the shape from the message itself.
  if (err instanceof Error) {
    const param = err instanceof ParamError;
    const s = param ? 400 : status;
    const type = param || status < 500 ? "invalid_request_error" : "api_error";
    return clientFormat === "anthropic"
      ? { status: s, body: { type: "error", error: { type, message: err.message }, request_id: requestId() } }
      : { status: s, body: { error: { message: err.message, type, code: null } } };
  }

  // Upstream error: map (or, same format, preserve) the error type.
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const upstream = typeof e.upstream === "number" ? e.upstream : status;
  const b = (typeof e.body === "object" && e.body !== null ? e.body : {}) as Record<string, unknown>;
  const inner = (typeof b.error === "object" && b.error !== null ? b.error : {}) as Record<string, unknown>;
  const type = typeof inner.type === "string" ? inner.type : undefined;
  const message = typeof inner.message === "string" ? inner.message : "upstream error";
  const anthropicUpstream = isAnthropicBody(b);

  if (clientFormat === "anthropic") {
    const t = anthropicUpstream ? type ?? "api_error" : toAnthropicType(upstream, type);
    return { status, body: { type: "error", error: { type: t, message }, request_id: requestId() } };
  }
  const t = anthropicUpstream ? toOpenAIType(upstream, type) : type ?? "api_error";
  const code = !anthropicUpstream && typeof inner.code === "string" ? inner.code : null;
  return { status, body: { error: { message, type: t, code } } };
}
