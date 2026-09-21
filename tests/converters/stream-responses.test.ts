import { test, expect } from "bun:test";
import { parseResponsesEvent, ResponsesStreamEncoder } from "../../src/converters/stream-responses";

test("parseResponsesEvent maps verified event names", () => {
  expect(parseResponsesEvent('{"type":"response.output_text.delta","delta":"He"}'))
    .toEqual([{ type: "text_delta", text: "He" }]);
  expect(parseResponsesEvent('{"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"f","arguments":""}}'))
    .toEqual([{ type: "tool_start", index: 0, id: "c1", name: "f" }]);
  expect(parseResponsesEvent('{"type":"response.function_call_arguments.delta","delta":"{\\"a\\""}'))
    .toEqual([{ type: "tool_delta", index: 0, partialJson: '{"a"' }]);
  expect(parseResponsesEvent('{"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }]);
  expect(parseResponsesEvent('{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}'))
    .toEqual([{ type: "end", stopReason: "length" }]);
  expect(parseResponsesEvent('{"type":"response.created","response":{}}')).toEqual([]);
});
test("encoder emits minimal viable event set", () => {
  const e = new ResponsesStreamEncoder();
  const out = e.start() + e.push({ type: "text_delta", text: "Hi" })
    + e.finish("stop", { inputTokens: 3, outputTokens: 2 });
  expect(out).toContain('"type":"response.created"');
  expect(out).toContain('"type":"response.output_text.delta","item_id"');
  expect(out).toContain('"type":"response.completed"');
  expect(out).toContain('"total_tokens":5');
});
