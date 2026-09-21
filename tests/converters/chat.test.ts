import { test, expect } from "bun:test";
import { chatToIr, irToChat, chatResponseToIr, irToChatResponse, toolResultToString, ParamError } from "../../src/converters/chat";
import type { IRRequest } from "../../src/types/ir";

const chatReq = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"SF\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "72F" },
  ],
  tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
  tool_choice: "auto", temperature: 0.5, max_tokens: 100, stop: ["END"],
  presence_penalty: 0.5, seed: 42,
};

test("chatToIr hoists system, maps tools round shape, records dropped params", () => {
  const { ir, dropped } = chatToIr(chatReq);
  expect(ir.system).toBe("be brief");
  expect(ir.messages).toHaveLength(3);
  expect(ir.messages[0]).toEqual({ role: "user", content: "hi" });
  const asst = ir.messages[1].content as any[];
  expect(asst[0].type).toBe("tool_use");
  expect(asst[0].input).toEqual({ city: "SF" });
  expect(ir.messages[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1", content: "72F" });
  expect(ir.tools![0]).toEqual({ name: "get_weather", description: "w", parameters: { type: "object" } });
  expect(ir.maxTokens).toBe(100);
  expect(ir.stop).toEqual(["END"]);
  expect(dropped).toContain("presence_penalty");
  expect(dropped).toContain("seed");
});

test("maxTokens defaults to 4096 when absent", () => {
  const { ir } = chatToIr({ model: "m", messages: [{ role: "user", content: "x" }] });
  expect(ir.maxTokens).toBe(4096);
});

test("bare string stop is normalized to array", () => {
  const { ir } = chatToIr({ model: "m", messages: [{ role: "user", content: "x" }], stop: "END" });
  expect(ir.stop).toEqual(["END"]);
});

test("null stop stays undefined", () => {
  const { ir } = chatToIr({ model: "m", messages: [{ role: "user", content: "x" }], stop: null });
  expect(ir.stop).toBeUndefined();
});

test("stream:true maps into ir.stream (streaming no longer rejected)", () => {
  expect(chatToIr({ model: "m", messages: [{ role: "user", content: "x" }], stream: true }).ir.stream).toBe(true);
  expect(chatToIr({ model: "m", messages: [{ role: "user", content: "x" }] }).ir.stream).toBe(false);
});

test("malformed tool call arguments throw ParamError naming the tool", () => {
  expect(() => chatToIr({ model: "m", messages: [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{bad" } }] },
  ] })).toThrow(ParamError);
  expect(() => chatToIr({ model: "m", messages: [
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{bad" } }] },
  ] })).toThrow(/malformed tool call arguments for get_weather/);
});

test("upstream malformed tool args degrade to empty input, not a throw", () => {
  const ir = chatResponseToIr({ id: "r", model: "m", choices: [{ index: 0,
    message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{bad" } }] },
    finish_reason: "tool_calls" }] });
  expect((ir.content[0] as any).input).toEqual({});
  expect((ir.content[0] as any).name).toBe("f");
});

test("n > 1 throws ParamError", () => {
  expect(() => chatToIr({ ...chatReq, n: 3 })).toThrow(ParamError);
});

test("response_format json_object throws, json_schema maps", () => {
  expect(() => chatToIr({ ...chatReq, response_format: { type: "json_object" } })).toThrow(/json_object/);
  const { ir } = chatToIr({ ...chatReq, response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
  expect(ir.structuredOutput).toEqual({ type: "object" });
});

test("reasoning_effort maps into ir.effort (none/minimal -> low)", () => {
  expect(chatToIr({ ...chatReq, reasoning_effort: "none" }).ir.effort).toBe("low");
  expect(chatToIr({ ...chatReq, reasoning_effort: "high" }).ir.effort).toBe("high");
});

test("irToChat restores system first and tool_calls shape", () => {
  const { ir } = chatToIr(chatReq);
  const out = irToChat(ir) as any;
  expect(out.messages[0]).toEqual({ role: "system", content: "be brief" });
  expect(out.messages[2].tool_calls[0].function.arguments).toBe("{\"city\":\"SF\"}");
  expect(out.max_tokens).toBe(100);
});

test("response mapping round trip", () => {
  const chatRes = {
    id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hello", tool_calls: [
      { id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const ir = chatResponseToIr(chatRes);
  expect(ir.stopReason).toBe("tool_use");
  expect(ir.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  const back = irToChatResponse(ir) as any;
  expect(back.object).toBe("chat.completion");
  expect(back.choices[0].message.tool_calls[0].id).toBe("c1");
  expect(back.choices[0].finish_reason).toBe("tool_calls");
  expect(back.usage.total_tokens).toBe(15);
});

const irWithImages: IRRequest = {
  model: "m", messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", mediaType: "image/png", data: "QUJD" },
    { type: "image", mediaType: "url", data: "https://example.com/x.png" },
  ] }], maxTokens: 10, stream: false,
};

test("irToChat serializes image parts to image_url (data: for base64, raw for url)", () => {
  const out = irToChat(irWithImages) as any;
  expect(out.messages[0].content).toEqual([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    { type: "image_url", image_url: { url: "https://example.com/x.png" } },
  ]);
});

test("toolResultToString flattens anthropic-style content blocks", () => {
  expect(toolResultToString("ok")).toBe("ok");
  expect(toolResultToString([{ type: "text", text: "ok" }])).toBe("ok");
  expect(toolResultToString([
    { type: "image", source: { type: "base64" } },
    { type: "text", text: "a" },
    { type: "text", text: "b" },
  ])).toBe("ab");
  expect(toolResultToString(42)).toBe("42");
});

test("irToChat stringifies tool_result array content instead of [object Object]", () => {
  const ir: IRRequest = { model: "m", messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "ok" }] }] },
  ], maxTokens: 10, stream: false };
  const out = irToChat(ir) as any;
  expect(out.messages[1].content).toBe("ok");
  expect(out.messages[1].tool_call_id).toBe("c1");
});

test("tool_call missing function -> ParamError", () => {
  expect(() => chatToIr({ model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function" }] }] })).toThrow(ParamError);
});
