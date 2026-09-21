import { test, expect } from "bun:test";
import { toClientError } from "../../src/converters/errors";

test("openai client gets openai error shape", () => {
  const r = toClientError(400, new Error("bad input"), "openai_chat");
  expect(r.status).toBe(400);
  expect(r.body.error).toMatchObject({ message: "bad input", type: "invalid_request_error" });
});
test("anthropic client gets anthropic error shape", () => {
  const r = toClientError(502, { upstream: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, "anthropic");
  expect(r.body).toMatchObject({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  expect(r.body.request_id).toBeDefined();   // generated request id, never upstream's raw shape leak
});
test("upstream openai error -> anthropic client shape", () => {
  const r = toClientError(502, { upstream: 429, body: { error: { message: "rate limited", type: "requests", code: "x" } } }, "anthropic");
  expect(r.body.error).toMatchObject({ type: "rate_limit_error", message: "rate limited" });
});
test("upstream 401 classifies as authentication error toward anthropic client", () => {
  const r = toClientError(502, { upstream: 401, body: { error: { message: "bad key", type: "invalid_api_key" } } }, "anthropic");
  expect((r.body as { error?: { type?: string } }).error?.type).toBe("authentication_error");
});
test("upstream 403 classifies as authentication toward anthropic client", () => {
  const r = toClientError(502, { upstream: 403, body: { error: { message: "forbidden", type: "insufficient_quota" } } }, "anthropic");
  expect((r.body as any).error.type).toBe("authentication_error");
});
test("upstream 403 classifies as authentication toward openai client", () => {
  const r = toClientError(502, { upstream: 403, body: { type: "error", error: { type: "permission_error", message: "forbidden" } } }, "openai_chat");
  expect((r.body as { error?: { type?: string } }).error?.type).toBe("authentication_error");
});
