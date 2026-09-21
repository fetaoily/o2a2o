import { test, expect } from "bun:test";
import { SseLineReader } from "../../src/core/sse";

test("frames split across chunks reassemble", () => {
  const r = new SseLineReader();
  expect(r.push('data: {"a"')).toEqual([]);
  expect(r.push(':1}\n\ndata: [DONE]\n\n')).toEqual([{ data: '{"a":1}' }, { data: "[DONE]" }]);
});
test("event line captured", () => {
  const r = new SseLineReader();
  expect(r.push('event: message_start\ndata: {"type":"message_start"}\n\n'))
    .toEqual([{ event: "message_start", data: '{"type":"message_start"}' }]);
});
