import { test, expect } from "bun:test";
import { detectFormat } from "../../src/core/format-detector";

test("by path", () => {
  expect(detectFormat("/v1/chat/completions", {})).toBe("openai_chat");
  expect(detectFormat("/v1/responses", {})).toBe("openai_responses");
  expect(detectFormat("/v1/messages", {})).toBe("anthropic");
});
test("body fallback: input -> responses", () =>
  expect(detectFormat("/", { input: "x" })).toBe("openai_responses"));
test("body fallback: messages[0].role -> chat", () =>
  expect(detectFormat("/", { messages: [{ role: "user", content: "x" }] })).toBe("openai_chat"));
test("body fallback: messages + max_tokens -> anthropic", () =>
  expect(detectFormat("/", { messages: [{ content: "x" }], max_tokens: 10 })).toBe("anthropic"));
test("undetectable throws", () =>
  expect(() => detectFormat("/", {})).toThrow(/unable to detect/i));
