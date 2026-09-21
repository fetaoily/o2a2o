import { test, expect } from "bun:test";
import { responsesToIr, irToResponses, responsesResponseToIr, irToResponsesResponse } from "../../src/converters/responses";

const respReq = {
  model: "claude-sonnet-4-5",
  instructions: "be brief",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_1", name: "f", arguments: "{\"a\":1}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ],
  max_output_tokens: 256, temperature: 0.3,
  text: { format: { type: "json_schema", json_schema: { schema: { type: "object" } } } },
  verbosity: "low",
};

test("responsesToIr maps instructions/input items and records dropped", () => {
  const { ir, dropped } = responsesToIr(respReq);
  expect(ir.system).toBe("be brief");
  expect(ir.maxTokens).toBe(256);
  expect(ir.messages).toHaveLength(3);
  expect((ir.messages[1].content as any[])[0]).toMatchObject({ type: "tool_use", id: "call_1", input: { a: 1 } });
  expect(ir.messages[2].role).toBe("tool");
  expect(ir.structuredOutput).toEqual({ type: "object" });
  expect(dropped).toContain("verbosity");
});

test("string input becomes a single user message", () => {
  const { ir } = responsesToIr({ model: "m", input: "hello" });
  expect(ir.messages).toEqual([{ role: "user", content: "hello" }]);
  expect(ir.maxTokens).toBe(4096);
});

test("irToResponses restores items", () => {
  const { ir } = responsesToIr(respReq);
  const out = irToResponses(ir) as any;
  expect(out.instructions).toBe("be brief");
  expect(out.max_output_tokens).toBe(256);
  expect(out.input[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
  expect(out.input[1].arguments).toBe("{\"a\":1}");
});

test("response mapping: output_text, function_call, incomplete reason", () => {
  const res = { id: "resp_1", model: "gpt-4o", status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hey", annotations: [] }] },
      { id: "fc_1", type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
    ],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } };
  const ir = responsesResponseToIr(res);
  expect(ir.stopReason).toBe("length");
  expect(ir.content[0]).toEqual({ type: "text", text: "hey" });
  expect(ir.content[1]).toMatchObject({ type: "tool_use", name: "f" });
  const back = irToResponsesResponse(ir) as any;
  expect(back.object).toBe("response");
  expect(back.status).toBe("completed");
  expect(back.output[0].content[0].type).toBe("output_text");
  expect(back.usage).toEqual({ input_tokens: 7, output_tokens: 4, total_tokens: 11 });
});
