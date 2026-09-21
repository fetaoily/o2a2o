// anthropic stream codec: upstream message SSE events ->
// StreamEvent parsing, and StreamEvent -> anthropic SSE encoding
// (TECH-DESIGN section 10). Reuses the StreamEvent union from the
// openai_chat codec and the stop_reason tables from anthropic.ts.
import { encodeSse } from "../core/sse";
import { IR_TO_STOP, STOP_TO_IR } from "./anthropic";
import type { StreamEvent } from "./stream-chat";

// Parses anthropic message SSE frames into semantic events. Instantiate one
// parser per upstream stream: it carries the input_tokens reported by
// message_start so the end event built from message_delta can include it
// (anthropic splits usage across the two events). Sharing one instance
// between concurrent streams would cross-contaminate that stash.
export class AnthropicSseParser {
  private streamInputTokens = 0;

  // No construction-time metadata: all state is per-stream instance state.
  constructor() {}

  // Parses one upstream event frame (event name + data payload) into
  // semantic events. Transport-only events (message_stop, ping,
  // content_block_stop) and events without a semantic equivalent (text
  // block lifecycle, thinking deltas) produce nothing; unknown event types
  // are tolerated with a debug log (official guidance: new event types may
  // appear at any time).
  parseEvent(event: string | undefined, data: string): StreamEvent[] {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn("[anthropic] dropping malformed stream event: not valid JSON");
      return [];
    }
    if (parsed === null || typeof parsed !== "object") {
      console.warn("[anthropic] dropping malformed stream event: not an object");
      return [];
    }
    const type = typeof parsed.type === "string" ? parsed.type : event;
    switch (type) {
      case "message_start": {
        const inputTokens = parsed.message?.usage?.input_tokens;
        this.streamInputTokens = typeof inputTokens === "number" ? inputTokens : 0;
        return [{ type: "start" }];
      }
      case "content_block_start": {
        const block = parsed.content_block;
        if (block?.type !== "tool_use") {
          if (block?.type !== undefined && block?.type !== "text")
            console.debug(`[anthropic] dropping unsupported content block type: ${String(block.type)}`);
          return [];
        }
        return [{
          type: "tool_start",
          index: typeof parsed.index === "number" ? parsed.index : 0,
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
        }];
      }
      case "content_block_delta": {
        const delta = parsed.delta;
        const index = typeof parsed.index === "number" ? parsed.index : 0;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "")
          return [{ type: "text_delta", text: delta.text }];
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json !== "")
          return [{ type: "tool_delta", index, partialJson: delta.partial_json }];
        if (delta?.type !== undefined)
          console.debug(`[anthropic] dropping unsupported delta type: ${String(delta.type)}`);
        return [];
      }
      case "content_block_stop":
        return [];
      case "message_delta": {
        const stopReason = STOP_TO_IR[parsed.delta?.stop_reason ?? ""] ?? "stop";
        const outputTokens = parsed.usage?.output_tokens;
        return typeof outputTokens === "number"
          ? [{ type: "end", stopReason, usage: { inputTokens: this.streamInputTokens, outputTokens } }]
          : [{ type: "end", stopReason }];
      }
      case "message_stop":
      case "ping":
        return [];
      case "error":
        return [{ type: "error", message: String(parsed.error?.message ?? "") }];
      default:
        console.debug(`[anthropic] dropping unknown stream event: ${String(type)}`);
        return [];
    }
  }
}

// Bare-function wrapper bound to one module-level parser instance. It keeps
// the pre-refactor cross-call semantics that the brief's verbatim tests rely
// on (message_start stashing input_tokens for a later message_delta call);
// stream loops should instantiate AnthropicSseParser once per stream instead.
const defaultParser = new AnthropicSseParser();

export function parseAnthropicEvent(event: string | undefined, data: string): StreamEvent[] {
  return defaultParser.parseEvent(event, data);
}

type StopReason = Extract<StreamEvent, { type: "end" }>["stopReason"];

// Builds anthropic message SSE frames from StreamEvents. The envelope
// (id / model / usage) lives inside message_start's message object
// (section 10), so no constructor metadata is needed: id and model are
// synthesized here (plumbing of real values is a later task). A text block
// opens together with message_start at index 0, matching upstream streams;
// tool blocks open at their event index. finish() closes any open block,
// emits message_delta (stop_reason reversed via IR_TO_STOP, cumulative
// output_tokens) and terminates with message_stop.
export class AnthropicStreamEncoder {
  private openBlock: { index: number; kind: "text" | "tool" } | undefined;
  private nextIndex = 0;
  private outputTokens = 0;
  private stopReason: StopReason = "stop";
  private endSeen = false;
  private finishSent = false;
  private readonly id = `msg_${crypto.randomUUID()}`;
  private readonly model = "unknown";

  private frame(body: Record<string, unknown>, event: string): string {
    return encodeSse(JSON.stringify(body), event);
  }

  private textBlockStart(index: number): string {
    return this.frame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start");
  }

  private closeOpenBlock(): string {
    if (this.openBlock === undefined) return "";
    const index = this.openBlock.index;
    this.openBlock = undefined;
    return this.frame({ type: "content_block_stop", index }, "content_block_stop");
  }

  // message_start with the full message envelope, then the initial text
  // content block (index 0).
  start(inputTokens?: number): string {
    const messageStart = this.frame({
      type: "message_start",
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens ?? 0, output_tokens: 0 },
      },
    }, "message_start");
    this.openBlock = { index: this.nextIndex++, kind: "text" };
    return messageStart + this.textBlockStart(this.openBlock.index);
  }

  push(ev: StreamEvent): string {
    switch (ev.type) {
      case "start":
        // message_start went out from start(); nothing to emit.
        return "";
      case "text_delta": {
        let out = "";
        if (this.openBlock === undefined || this.openBlock.kind !== "text") {
          out += this.closeOpenBlock();
          this.openBlock = { index: this.nextIndex++, kind: "text" };
          out += this.textBlockStart(this.openBlock.index);
        }
        out += this.frame({
          type: "content_block_delta",
          index: this.openBlock.index,
          delta: { type: "text_delta", text: ev.text },
        }, "content_block_delta");
        return out;
      }
      case "tool_start": {
        let out = this.closeOpenBlock();
        this.openBlock = { index: ev.index, kind: "tool" };
        this.nextIndex = Math.max(this.nextIndex, ev.index + 1);
        out += this.frame({
          type: "content_block_start",
          index: ev.index,
          content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} },
        }, "content_block_start");
        return out;
      }
      case "tool_delta":
        return this.frame({
          type: "content_block_delta",
          index: ev.index,
          delta: { type: "input_json_delta", partial_json: ev.partialJson },
        }, "content_block_delta");
      case "end": {
        // The message_delta frame is emitted by finish(); this only records
        // what it should carry.
        if (this.endSeen) return "";
        this.endSeen = true;
        this.stopReason = ev.stopReason;
        if (ev.usage) this.outputTokens = ev.usage.outputTokens;
        return "";
      }
      case "error":
        // Mid-stream errors surface as an error event frame (section 10);
        // the caller closes the stream afterwards.
        return this.frame({ type: "error", error: { type: "api_error", message: ev.message } }, "error");
    }
  }

  // Closes the stream: content_block_stop for any open block, then
  // message_delta with the stored stop_reason and cumulative output_tokens,
  // then message_stop as the terminator.
  finish(): string {
    if (this.finishSent) return "";
    this.finishSent = true;
    let out = this.closeOpenBlock();
    out += this.frame({
      type: "message_delta",
      delta: { stop_reason: IR_TO_STOP[this.stopReason], stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    }, "message_delta");
    return out + this.frame({ type: "message_stop" }, "message_stop");
  }
}
