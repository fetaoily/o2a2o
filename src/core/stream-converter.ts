// Streaming hub (plan Task 6): byte-level passthrough plus the
// parse → StreamEvent → encode conversion pipeline. Same-format streams go
// through pipeThrough untouched; cross-format streams are hubbed through the
// StreamEvent union so any source format can feed any destination format.
// Parsers and encoders are instantiated per stream — their internal state
// (anthropic input_tokens stash, responses tool index, encoder block/item
// accumulators) must never be shared between concurrent streams.
import type { InputFormat } from "./format-detector";
import { SseLineReader, type SseFrame } from "./sse";
import type { StreamTimeoutManager } from "./stream-timeout-manager";
import { ChatStreamEncoder, parseChatChunk, type StreamEvent } from "../converters/stream-chat";
import { AnthropicSseParser, AnthropicStreamEncoder } from "../converters/stream-anthropic";
import { ResponsesSseParser, ResponsesStreamEncoder } from "../converters/stream-responses";

type TokenUsage = { inputTokens: number; outputTokens: number };
type EndEvent = Extract<StreamEvent, { type: "end" }>;

// Same-protocol passthrough: bytes flow unchanged, the monitor notes every
// upstream chunk. disarm() runs on source close, source error and downstream
// cancel (the finally-ish paths). On a timeout fire the stream owner closes
// the stream.
export function pipeThrough(src: ReadableStream<Uint8Array>, monitor: StreamTimeoutManager): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        monitor.disarm();
        throw e;
      }
      if (chunk.done) {
        monitor.disarm();
        controller.close();
        return;
      }
      monitor.noteData();
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      monitor.disarm();
      return reader.cancel(reason);
    },
  });
}

// Cross-format conversion: source bytes → TextDecoder({stream:true}) →
// SseLineReader → per-format parser → StreamEvent[] → destination encoder →
// SSE bytes. The usage carried by end events is forwarded to usageSink.
export function convertStream(opts: {
  srcFormat: InputFormat;
  dstFormat: InputFormat;
  source: ReadableStream<Uint8Array>;
  monitor: StreamTimeoutManager;
  usageSink?: (u: TokenUsage) => void;
}): ReadableStream<Uint8Array> {
  const { srcFormat, dstFormat, source, monitor, usageSink } = opts;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const sse = new SseLineReader();
  const output = new TextEncoder();

  // Source parser, instantiated per stream. anthropic frames carry their
  // event name separately (SseLineReader captures "event:" lines); the other
  // parsers read only the data payload. chat parsing is stateless.
  const parseFrame: (frame: SseFrame) => StreamEvent[] = (() => {
    if (srcFormat === "anthropic") {
      const parser = new AnthropicSseParser();
      return (frame) => parser.parseEvent(frame.event, frame.data);
    }
    if (srcFormat === "openai_responses") {
      const parser = new ResponsesSseParser();
      return (frame) => parser.parseEvent(frame.data);
    }
    return (frame) => parseChatChunk(frame.data);
  })();

  // Destination encoder, instantiated per stream. The anthropic / responses
  // encoders emit their lifecycle opener lazily before the first event
  // (message_start / response.created); the chat encoder opens on the start
  // event itself. End-event state feeds the encoders' finish() variants.
  let usage: TokenUsage | undefined;
  let stopReason: EndEvent["stopReason"] = "stop";
  const adapter = (() => {
    if (dstFormat === "anthropic") {
      const enc = new AnthropicStreamEncoder();
      return { begin: () => enc.start(), push: (ev: StreamEvent) => enc.push(ev), finish: () => enc.finish() };
    }
    if (dstFormat === "openai_responses") {
      const enc = new ResponsesStreamEncoder();
      return { begin: () => enc.start(), push: (ev: StreamEvent) => enc.push(ev), finish: () => enc.finish(stopReason, usage) };
    }
    const enc = new ChatStreamEncoder();
    return { begin: () => "", push: (ev: StreamEvent) => enc.push(ev), finish: () => enc.finish(usage) };
  })();

  let began = false;
  const ensureBegin = (): string => {
    if (began) return "";
    began = true;
    return adapter.begin();
  };

  // Converts parsed frames into output SSE text. An error event ends the
  // stream right after its error frame (the codecs' contract: the caller
  // closes the stream; no finish/termination frames follow an error).
  const pumpEvents = (frames: SseFrame[]): { out: string; errored: boolean } => {
    let out = "";
    for (const frame of frames) {
      for (const ev of parseFrame(frame)) {
        if (ev.type === "end") {
          stopReason = ev.stopReason;
          if (ev.usage) {
            usage = ev.usage;
            usageSink?.(ev.usage);
          }
        }
        out += ensureBegin();
        out += adapter.push(ev);
        if (ev.type === "error") return { out, errored: true };
      }
    }
    return { out, errored: false };
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          monitor.disarm();
          controller.error(e);
          return;
        }
        if (chunk.done) {
          const { out } = pumpEvents(sse.push(decoder.decode()));
          if (out !== "") controller.enqueue(output.encode(out));
          const finishOut = adapter.finish();
          if (finishOut !== "") controller.enqueue(output.encode(finishOut));
          monitor.disarm();
          controller.close();
          return;
        }
        monitor.noteData();
        const { out, errored } = pumpEvents(sse.push(decoder.decode(chunk.value, { stream: true })));
        if (out !== "") controller.enqueue(output.encode(out));
        if (errored) {
          monitor.disarm();
          void reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        if (out !== "") return; // pull satisfied; frames may span further chunks
      }
    },
    cancel(reason) {
      monitor.disarm();
      return reader.cancel(reason);
    },
  });
}
