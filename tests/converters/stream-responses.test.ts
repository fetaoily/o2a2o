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
test("response.incomplete reason content_filter maps to IR content_filter", () => {
  expect(parseResponsesEvent('{"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}'))
    .toEqual([{ type: "end", stopReason: "content_filter" }]);
  // an unrecognized reason keeps falling back to stop
  expect(parseResponsesEvent('{"type":"response.incomplete","response":{"incomplete_details":{"reason":"other_new_reason"}}}'))
    .toEqual([{ type: "end", stopReason: "stop" }]);
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
test("text then tool_start(index 0) allocates distinct output indexes", () => {
  // Chat upstreams number their first tool call 0; the encoder must allocate
  // its own monotonic output indexes so the function_call item cannot collide
  // with the message item at output_index 0.
  const e = new ResponsesStreamEncoder();
  const out = e.start()
    + e.push({ type: "text_delta", text: "Let me check" })
    + e.push({ type: "tool_start", index: 0, id: "c1", name: "f" })
    + e.push({ type: "tool_delta", index: 0, partialJson: '{"x":1}' })
    + e.finish("tool_use");
  const added = [...out.matchAll(/"type":"response\.output_item\.added","output_index":(\d+)/g)].map((m) => Number(m[1]));
  expect(added).toEqual([0, 1]);
  expect(out).toContain('"delta":"Let me check"');   // preamble text survives
  const argsDelta = out.match(/"type":"response\.function_call_arguments\.delta","item_id":"[^"]*","output_index":(\d+)/);
  expect(argsDelta?.[1]).toBe("1");                  // delta binds to the open tool item's index
});
test("constructor metadata surfaces in response.created when provided", () => {
  const e = new ResponsesStreamEncoder({ id: "resp_fixed", model: "gpt-4o" });
  const out = e.start();
  expect(out).toContain('"id":"resp_fixed"');
  expect(out).toContain('"model":"gpt-4o"');
});
test("encoder error path emits responses error event frame", () => {
  const e = new ResponsesStreamEncoder();
  const out = e.start() + e.push({ type: "error", message: "boom" }) + e.finish("stop");
  expect(out).toContain('"type":"error"');
  expect(out).toContain('"code":"server_error"');
});
test("finish length emits response.incomplete with max_output_tokens reason", () => {
  const e = new ResponsesStreamEncoder();
  const out = e.start() + e.push({ type: "text_delta", text: "Hi" })
    + e.finish("length", { inputTokens: 3, outputTokens: 2 });
  expect(out).toContain('"type":"response.incomplete"');
  expect(out).toContain('"reason":"max_output_tokens"');
  expect(out).toContain('"total_tokens":5');
});
test("finish content_filter emits response.incomplete with content_filter reason", () => {
  // The parser maps response.incomplete/content_filter -> stopReason
  // "content_filter"; the re-encode must not lose it as response.completed.
  const e = new ResponsesStreamEncoder();
  const out = e.start() + e.push({ type: "text_delta", text: "Hi" })
    + e.finish("content_filter", { inputTokens: 3, outputTokens: 2 });
  expect(out).toContain('"type":"response.incomplete"');
  expect(out).toContain('"reason":"content_filter"');
  expect(out).toContain('"total_tokens":5');
});
