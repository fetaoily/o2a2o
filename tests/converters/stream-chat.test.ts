import { test, expect } from "bun:test";
import { parseChatChunk, ChatStreamEncoder } from "../../src/converters/stream-chat";

test("parseChatChunk: role-only first chunk -> start, content delta -> text_delta", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}'))
    .toEqual([{ type: "start" }]);
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"content":"He"}}]}'))
    .toEqual([{ type: "text_delta", text: "He" }]);
});
test("parseChatChunk: tool_call start + arguments delta", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":""}}]}}]}'))
    .toEqual([{ type: "tool_start", index: 0, id: "c1", name: "f" }]);
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\""}}]}}]}'))
    .toEqual([{ type: "tool_delta", index: 0, partialJson: '{"a"' }]);
});
test("parseChatChunk: finish_reason and usage chunk", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'))
    .toEqual([{ type: "end", stopReason: "stop" }]);
  expect(parseChatChunk('{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }]);
});
test("encoder produces role chunk, deltas, finish, DONE", () => {
  const e = new ChatStreamEncoder();
  const out = [e.push({ type: "start" }), e.push({ type: "text_delta", text: "Hi" }),
    e.finish({ inputTokens: 3, outputTokens: 1 })].join("");
  expect(out).toContain('"role":"assistant"');
  expect(out).toContain('"content":"Hi"');
  expect(out).toContain('"finish_reason":"stop"');
  expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
});
test("finish_reason maps stop_reason table", () => {
  const e = new ChatStreamEncoder();
  expect(e.push({ type: "end", stopReason: "tool_use" })).toContain('"tool_calls"');
});
test("encoder chunks carry the verified envelope fields", () => {
  const e = new ChatStreamEncoder({ id: "chatcmpl-x", model: "gpt-4o" });
  const out = e.push({ type: "start" }) + e.push({ type: "text_delta", text: "Hi" }) + e.finish();
  expect(out).toContain('"id":"chatcmpl-x"');
  expect(out).toContain('"object":"chat.completion.chunk"');
  expect(out).toContain('"model":"gpt-4o"');
  expect(out).toContain('"created":');
});
