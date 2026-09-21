// openai_chat stream codec: upstream chat.completion.chunk JSON ->
// StreamEvent parsing, and StreamEvent -> chat.completion.chunk SSE
// encoding (TECH-DESIGN section 10). Shared with the anthropic / responses
// stream codecs, which reuse the StreamEvent union.
import { encodeSse } from "../core/sse";
import { FINISH_TO_STOP, STOP_TO_FINISH } from "./chat";

export type StreamEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; partialJson: string }
  | { type: "end"; stopReason: "stop" | "length" | "tool_use" | "content_filter"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string };

type TokenUsage = { inputTokens: number; outputTokens: number };

// Transport-level end sentinel: handled by the stream loop, never mapped
// to a semantic event.
export function isDoneSentinel(data: string): boolean {
  return data === "[DONE]";
}

function toUsage(u: unknown): TokenUsage | undefined {
  if (u === null || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  return {
    inputTokens: typeof o.prompt_tokens === "number" ? o.prompt_tokens : 0,
    outputTokens: typeof o.completion_tokens === "number" ? o.completion_tokens : 0,
  };
}

// Parses one upstream data-line payload into semantic events. Empty data
// and [DONE] produce nothing; a malformed chunk is dropped with a warning
// (a single bad chunk must not kill the stream).
export function parseChatChunk(data: string): StreamEvent[] {
  if (data === "" || isDoneSentinel(data)) return [];
  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    console.warn("[openai_chat] dropping malformed stream chunk: not valid JSON");
    return [];
  }
  if (chunk === null || typeof chunk !== "object") {
    console.warn("[openai_chat] dropping malformed stream chunk: not an object");
    return [];
  }
  const events: StreamEvent[] = [];
  const choices: any[] = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    const delta = choice?.delta ?? {};
    if (delta.role === "assistant") events.push({ type: "start" });
    if (typeof delta.content === "string" && delta.content !== "")
      events.push({ type: "text_delta", text: delta.content });
    const toolCalls: any[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      const index = typeof tc?.index === "number" ? tc.index : 0;
      if (tc?.id !== undefined || tc?.function?.name !== undefined)
        events.push({ type: "tool_start", index, id: String(tc.id ?? ""), name: String(tc.function?.name ?? "") });
      if (typeof tc?.function?.arguments === "string" && tc.function.arguments !== "")
        events.push({ type: "tool_delta", index, partialJson: tc.function.arguments });
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") {
      const usage = toUsage(chunk.usage);
      events.push(usage
        ? { type: "end", stopReason: FINISH_TO_STOP[choice.finish_reason] ?? "stop", usage }
        : { type: "end", stopReason: FINISH_TO_STOP[choice.finish_reason] ?? "stop" });
    }
  }
  // stream_options.include_usage final chunk: choices is empty, usage only.
  if (choices.length === 0) {
    const usage = toUsage(chunk.usage);
    if (usage) events.push({ type: "end", stopReason: "stop", usage });
  }
  if (typeof chunk.error?.message === "string")
    events.push({ type: "error", message: chunk.error.message });
  return events;
}

function usageWire(u: TokenUsage): Record<string, number> {
  return { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.inputTokens + u.outputTokens };
}

// Builds openai_chat chat.completion.chunk SSE frames from StreamEvents.
// Data-carrying chunk frames carry the verified chunk envelope (id /
// object / created / model, section 18), synthesized once at construction
// so one stream shares a single id and timestamp. The error frame carries
// no envelope, matching upstream mid-stream error frames.
export class ChatStreamEncoder {
  private roleSent = false;
  private finishSent = false;
  private readonly id: string;
  private readonly model: string;
  private readonly created: number;

  constructor(meta?: { id?: string; model?: string }) {
    this.id = meta?.id ?? `chatcmpl-${crypto.randomUUID()}`;
    this.model = meta?.model ?? "unknown";
    this.created = Math.floor(Date.now() / 1000);
  }

  // One chunk frame with the envelope + the given body fields.
  private chunk(body: Record<string, unknown>): string {
    return encodeSse(JSON.stringify({
      id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, ...body,
    }));
  }

  // Returns the SSE text for this event (possibly several frames, possibly
  // "" when the event produces no output).
  push(ev: StreamEvent): string {
    switch (ev.type) {
      case "start": {
        if (this.roleSent) return "";
        this.roleSent = true;
        return this.chunk({ choices: [{ index: 0, delta: { role: "assistant" } }] });
      }
      case "text_delta":
        return this.chunk({ choices: [{ index: 0, delta: { content: ev.text } }] });
      case "tool_start":
        return this.chunk({
          choices: [{ index: 0, delta: { tool_calls: [{ index: ev.index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] } }],
        });
      case "tool_delta":
        return this.chunk({
          choices: [{ index: 0, delta: { tool_calls: [{ index: ev.index, function: { arguments: ev.partialJson } }] } }],
        });
      case "end": {
        if (this.finishSent) return "";
        this.finishSent = true;
        const choice: Record<string, unknown> = { index: 0, delta: {}, finish_reason: STOP_TO_FINISH[ev.stopReason] };
        if (ev.usage) choice.usage = usageWire(ev.usage);
        return this.chunk({ choices: [choice] });
      }
      case "error":
        // Mid-stream errors surface as an error JSON frame (section 10);
        // the caller closes the stream afterwards. No envelope, matching
        // upstream error frames.
        return encodeSse(JSON.stringify({ error: { message: ev.message } }));
    }
  }

  // Closes the stream: the finish_reason frame if no end event produced it
  // yet (usage embedded when provided), then the choices:[] usage frame
  // when usage is known, then the [DONE] sentinel as the last bytes.
  finish(usage?: TokenUsage): string {
    const end: StreamEvent = usage
      ? { type: "end", stopReason: "stop", usage }
      : { type: "end", stopReason: "stop" };
    let out = this.push(end);
    if (usage) out += this.chunk({ choices: [], usage: usageWire(usage) });
    return out + encodeSse("[DONE]");
  }
}
