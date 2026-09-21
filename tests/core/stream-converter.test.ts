import { test, expect } from "bun:test";
import { pipeThrough, convertStream } from "../../src/core/stream-converter";
import type { StreamTimeoutManager } from "../../src/core/stream-timeout-manager";

// Test helpers (plan: ~8-line utilities, intent-specified).
// SSE frames are authored as text; streamOf does the byte encoding.
const enc = (s: string) => s;
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const e = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { for (const chunk of chunks) c.enqueue(e.encode(chunk)); c.close(); },
  });
}
async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const d = new TextDecoder();
  let out = "";
  for await (const chunk of s) out += d.decode(chunk, { stream: true });
  return out + d.decode();
}
// Structural stub: records per-chunk noteData calls without real timers.
function fakeMonitor(onData: () => void = () => {}): StreamTimeoutManager {
  return { arm: () => {}, noteData: () => onData(), disarm: () => {} } as unknown as StreamTimeoutManager;
}

test("pipeThrough passes bytes and notes data", async () => {
  const src = streamOf([enc("data: {\"a\":1}\n\n"), enc("data: [DONE]\n\n")]);
  let bytes = 0; const monitor = fakeMonitor(() => bytes++);
  const out = pipeThrough(src, monitor);
  const text = await readAll(out);
  expect(text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  expect(bytes).toBe(2);
});
test("convertStream anthropic->chat end to end", async () => {
  const frames = enc('event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":4,"output_tokens":1}}}\n\n')
    + enc('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n')
    + enc('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n')
    + enc('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  let usage: any;
  const out = convertStream({ srcFormat: "anthropic", dstFormat: "openai_chat", source: streamOf([frames]), monitor: fakeMonitor(), usageSink: (u) => (usage = u) });
  const text = await readAll(out);
  expect(text).toContain('"content":"Hi"');
  expect(text).toContain('"finish_reason":"stop"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  expect(usage).toEqual({ inputTokens: 4, outputTokens: 3 });
});
