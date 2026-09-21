// openai_responses stream codec: upstream response SSE events ->
// StreamEvent parsing, and StreamEvent -> responses SSE encoding
// (TECH-DESIGN section 10, minimal viable event set). Reuses the
// StreamEvent union from the openai_chat codec.
import { encodeSse } from "../core/sse";
import type { StreamEvent } from "./stream-chat";

type TokenUsage = { inputTokens: number; outputTokens: number };

// Builds the end event from a response envelope, attaching usage when the
// envelope carries one.
function endEvent(stopReason: "stop" | "length" | "content_filter", response: any): StreamEvent {
  const usage = response?.usage;
  if (usage === null || typeof usage !== "object")
    return { type: "end", stopReason };
  return {
    type: "end",
    stopReason,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

// Parses openai_responses SSE events into semantic events. Instantiate one
// parser per upstream stream: it carries the output_index of the most recent
// function_call item so its response.function_call_arguments.delta events
// can be attributed to it (those events carry no index of their own).
// Sharing one instance between concurrent streams would cross-contaminate
// that index.
export class ResponsesSseParser {
  private lastToolIndex = 0;

  // No construction-time metadata: all state is per-stream instance state.
  constructor() {}

  // Parses one upstream data-line payload into semantic events. The minimal
  // viable mapping per the plan ruling; events without a semantic
  // equivalent (lifecycle, reasoning, item done events) produce nothing,
  // and unknown event types are tolerated with a debug log (official
  // guidance: new event types may appear at any time).
  parseEvent(data: string): StreamEvent[] {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn("[openai_responses] dropping malformed stream event: not valid JSON");
      return [];
    }
    if (parsed === null || typeof parsed !== "object") {
      console.warn("[openai_responses] dropping malformed stream event: not an object");
      return [];
    }
    switch (parsed.type) {
      case "response.created":
        this.lastToolIndex = 0;
        return [];
      case "response.output_text.delta":
        return typeof parsed.delta === "string" && parsed.delta !== ""
          ? [{ type: "text_delta", text: parsed.delta }]
          : [];
      case "response.output_item.added": {
        const item = parsed.item;
        if (item?.type !== "function_call") return [];
        const index = typeof parsed.output_index === "number" ? parsed.output_index : 0;
        this.lastToolIndex = index;
        return [{ type: "tool_start", index, id: String(item.call_id ?? ""), name: String(item.name ?? "") }];
      }
      case "response.function_call_arguments.delta":
        return typeof parsed.delta === "string" && parsed.delta !== ""
          ? [{ type: "tool_delta", index: this.lastToolIndex, partialJson: parsed.delta }]
          : [];
      case "response.completed":
        return [endEvent("stop", parsed.response)];
      case "response.incomplete": {
        const reason = parsed.response?.incomplete_details?.reason;
        return [endEvent(reason === "max_output_tokens" ? "length" : "stop", parsed.response)];
      }
      case "response.failed":
        return [endEvent("content_filter", parsed.response)];
      case "error":
        return [{ type: "error", message: String(parsed.message ?? parsed.code ?? "unknown error") }];
      default:
        console.debug(`[openai_responses] dropping stream event without mapping: ${String(parsed.type)}`);
        return [];
    }
  }
}

// Bare-function wrapper bound to one module-level parser instance. It keeps
// the pre-refactor cross-call semantics that the brief's verbatim tests rely
// on (output_item.added setting the tool index for later arguments delta
// calls); stream loops should instantiate ResponsesSseParser once per stream
// instead.
const defaultParser = new ResponsesSseParser();

export function parseResponsesEvent(data: string): StreamEvent[] {
  return defaultParser.parseEvent(data);
}

// The item currently being streamed: one message item for text, one
// function_call item per tool call, each closed by output_item.done before
// the next opens.
interface OpenItem {
  outputIndex: number;
  id: string;
  kind: "message" | "function_call";
  callId: string;
  name: string;
  text: string;
  args: string;
}

// Builds openai_responses SSE frames from StreamEvents: the minimal viable
// event set (response.created, output_item.added, output_text.delta,
// output_item.done, response.completed) plus the function_call item with
// response.function_call_arguments.delta for tools and an error frame.
// The envelope (id / object / created_at / model) lives inside each event's
// embedded response object (section 10), so id and model are synthesized
// here (plumbing of real values is a later task).
export class ResponsesStreamEncoder {
  private readonly id = `resp_${crypto.randomUUID()}`;
  private readonly model = "unknown";
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private nextItemId = 0;
  private openItem: OpenItem | undefined;
  private readonly output: Record<string, unknown>[] = [];
  private finishSent = false;

  private frame(body: Record<string, unknown>): string {
    return encodeSse(JSON.stringify(body));
  }

  // The response envelope embedded in lifecycle events.
  private responseEnvelope(status: string, extra?: Record<string, unknown>): Record<string, unknown> {
    return { id: this.id, object: "response", created_at: this.createdAt, model: this.model, status, ...extra };
  }

  private itemEnvelope(item: OpenItem, status: string): Record<string, unknown> {
    return item.kind === "message"
      ? { id: item.id, type: "message", role: "assistant", status, content: [{ type: "output_text", text: item.text, annotations: [] }] }
      : { id: item.id, type: "function_call", call_id: item.callId, name: item.name, arguments: item.args, status };
  }

  private closeOpenItem(): string {
    if (this.openItem === undefined) return "";
    const item = this.openItem;
    this.openItem = undefined;
    this.output.push(this.itemEnvelope(item, "completed"));
    return this.frame({ type: "response.output_item.done", output_index: item.outputIndex, item: this.itemEnvelope(item, "completed") });
  }

  // response.created with the embedded response envelope.
  start(): string {
    return this.frame({ type: "response.created", response: this.responseEnvelope("in_progress") });
  }

  push(ev: StreamEvent): string {
    switch (ev.type) {
      case "start":
        // response.created went out from start(); nothing to emit.
        return "";
      case "text_delta": {
        let item = this.openItem;
        let out = "";
        if (item === undefined || item.kind !== "message") {
          out += this.closeOpenItem();
          item = { outputIndex: 0, id: `msg_${++this.nextItemId}`, kind: "message", callId: "", name: "", text: "", args: "" };
          this.openItem = item;
          out += this.frame({ type: "response.output_item.added", output_index: item.outputIndex, item: this.itemEnvelope(item, "in_progress") });
        }
        item.text += ev.text;
        out += this.frame({ type: "response.output_text.delta", item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: ev.text });
        return out;
      }
      case "tool_start": {
        let out = this.closeOpenItem();
        const item: OpenItem = { outputIndex: ev.index, id: `fc_${++this.nextItemId}`, kind: "function_call", callId: ev.id, name: ev.name, text: "", args: "" };
        this.openItem = item;
        out += this.frame({ type: "response.output_item.added", output_index: item.outputIndex, item: this.itemEnvelope(item, "in_progress") });
        return out;
      }
      case "tool_delta": {
        const item = this.openItem;
        if (item !== undefined && item.kind === "function_call") item.args += ev.partialJson;
        return this.frame({
          type: "response.function_call_arguments.delta",
          item_id: item !== undefined && item.kind === "function_call" ? item.id : "",
          output_index: ev.index,
          delta: ev.partialJson,
        });
      }
      case "end":
        // The termination event goes out from finish().
        return "";
      case "error":
        // Mid-stream errors surface as an error event (section 10); the
        // caller closes the stream afterwards.
        return this.frame({ type: "error", code: "server_error", message: ev.message, param: null });
    }
  }

  // Closes the stream: output_item.done for the open item, then
  // response.completed whose embedded response carries the accumulated
  // output items and usage (total = input + output).
  finish(stopReason: "stop" | "length" | "tool_use" | "content_filter", usage?: TokenUsage): string {
    if (this.finishSent) return "";
    this.finishSent = true;
    let out = this.closeOpenItem();
    const response = this.responseEnvelope("completed", { output: [...this.output] });
    if (usage !== undefined)
      response.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
    return out + this.frame({ type: "response.completed", response });
  }
}
