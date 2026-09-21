// Request format detection: path prefix first, body fingerprint fallback
// (TECH-DESIGN §5 table order).
export type InputFormat = "openai_chat" | "openai_responses" | "anthropic";

export function detectFormat(path: string, body: unknown): InputFormat {
  if (path.endsWith("/v1/chat/completions")) return "openai_chat";
  if (path.endsWith("/v1/responses")) return "openai_responses";
  if (path.endsWith("/v1/messages")) return "anthropic";
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.input !== undefined) return "openai_responses";
  const messages = b.messages;
  if (Array.isArray(messages) && messages[0]?.role !== undefined) return "openai_chat";
  if (Array.isArray(messages) && b.max_tokens !== undefined) return "anthropic";
  throw new Error("unable to detect request format");
}
