import { test, expect } from "bun:test";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../../src/converters/anthropic";

const antReq = {
  model: "gpt-4o", max_tokens: 512, system: "be brief",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  ],
  tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
  tool_choice: { type: "any" }, stop_sequences: ["END"],
  metadata: { user_id: "u1" },
};

test("anthropicToIr maps blocks, strips cache_control/metadata", () => {
  const { ir, dropped } = anthropicToIr(antReq);
  expect(ir.system).toBe("be brief");
  expect(ir.maxTokens).toBe(512);
  expect((ir.messages[0].content as any[])[0]).toEqual({ type: "text", text: "hi" });
  expect((ir.messages[1].content as any[])[0]).toMatchObject({ type: "tool_use", id: "toolu_1", input: { a: 1 } });
  expect(ir.messages[2].role).toBe("tool");
  expect(ir.tools![0].parameters).toEqual({ type: "object" });
  expect(ir.toolChoice).toBe("required");
  expect(ir.stop).toEqual(["END"]);
  expect(dropped).toContain("cache_control");
  expect(dropped).toContain("metadata");
});

test("irToAnthropic restores native shape incl tool_choice any", () => {
  const { ir } = anthropicToIr(antReq);
  const out = irToAnthropic(ir) as any;
  expect(out.system).toBe("be brief");
  expect(out.max_tokens).toBe(512);
  expect(out.tool_choice).toEqual({ type: "any" });
  expect(out.stop_sequences).toEqual(["END"]);
  expect(out.messages[2].role).toBe("user");  // tool_result rides on a user message
});

test("ir.structuredOutput -> output_config.format; ir.effort -> output_config.effort", () => {
  const out = irToAnthropic({ model: "m", messages: [], maxTokens: 10, stream: false,
    structuredOutput: { type: "object" }, effort: "high" } as any) as any;
  expect(out.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } }, effort: "high" });
});

test("response mapping incl refusal -> content_filter and pause_turn -> stop", () => {
  const res = { id: "msg_1", model: "claude-x", stop_reason: "refusal",
    content: [{ type: "text", text: "no" }], usage: { input_tokens: 3, output_tokens: 2 } };
  expect(anthropicResponseToIr(res).stopReason).toBe("content_filter");
  expect(anthropicResponseToIr({ ...res, stop_reason: "pause_turn" }).stopReason).toBe("stop");
  const back = irToAnthropicResponse(anthropicResponseToIr(res)) as any;
  expect(back.type).toBe("message");
  expect(back.stop_reason).toBe("refusal");
  expect(back.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
});

test("stream:true maps into ir.stream (streaming no longer rejected)", () => {
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }], stream: true };
  expect(anthropicToIr(body).ir.stream).toBe(true);
});
