import { test, expect } from "bun:test";
import { parseAnthropicEvent, AnthropicStreamEncoder } from "../../src/converters/stream-anthropic";

test("parseAnthropicEvent full sequence", () => {
  expect(parseAnthropicEvent("message_start", '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}'))
    .toEqual([{ type: "start" }]);
  expect(parseAnthropicEvent("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'))
    .toEqual([{ type: "text_delta", text: "Hello" }]);
  expect(parseAnthropicEvent("content_block_start", '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}'))
    .toEqual([{ type: "tool_start", index: 1, id: "t1", name: "f" }]);
  expect(parseAnthropicEvent("content_block_delta", '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\""}}'))
    .toEqual([{ type: "tool_delta", index: 1, partialJson: '{"x"' }]);
  expect(parseAnthropicEvent("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 25, outputTokens: 15 } }]);
  expect(parseAnthropicEvent("ping", '{"type":"ping"}')).toEqual([]);
  expect(parseAnthropicEvent("error", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))
    .toEqual([{ type: "error", message: "Overloaded" }]);
});
test("encoder emits anthropic wire frames incl message_stop terminator", () => {
  const e = new AnthropicStreamEncoder();
  const out = e.start(25) + e.push({ type: "text_delta", text: "Hi" })
    + e.push({ type: "end", stopReason: "stop", usage: { inputTokens: 25, outputTokens: 3 } }) + e.finish();
  expect(out).toContain("event: message_start");
  expect(out).toContain('"type":"text_delta","text":"Hi"');
  expect(out).toContain('"stop_reason":"end_turn"');
  expect(out).toContain("event: message_stop");
});
test("encoder tool_use path emits content_block_start/stop with input_json_delta", () => {
  const e = new AnthropicStreamEncoder();
  const out = e.start() + e.push({ type: "tool_start", index: 1, id: "t1", name: "f" })
    + e.push({ type: "tool_delta", index: 1, partialJson: '{"x":1}' }) + e.finish();
  expect(out).toContain('"type":"tool_use","id":"t1","name":"f"');
  expect(out).toContain("input_json_delta");
});
