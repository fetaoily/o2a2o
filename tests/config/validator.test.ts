import { test, expect } from "bun:test";
import { validateConfig, CONFIG_TEMPLATE } from "../../src/config/validator";
import type { AppConfig } from "../../src/config/loader";

const base = (): AppConfig => ({
  server: { port: 8080, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-1", priority: 1 }] }],
  aliases: {},
  api_keys: {},
});

test("valid config passes", () => expect(validateConfig(base())).toEqual([]));

test("empty models rejected", () => {
  const c = base(); c.models = [];
  expect(validateConfig(c)).toEqual(["models must not be empty"]);
});

test("duplicate model names rejected", () => {
  const c = base();
  c.models.push({ ...c.models[0] });
  expect(validateConfig(c)[0]).toMatch(/duplicate model name/);
});

test("bad provider rejected", () => {
  const c = base();
  (c.models[0] as any).provider = "gemini";
  expect(validateConfig(c)[0]).toMatch(/invalid provider/);
});

test("alias pointing to unknown model rejected", () => {
  const c = base(); c.aliases = { x: "no-such-model" };
  expect(validateConfig(c)[0]).toMatch(/alias 'x' resolves to unknown model/);
});

test("non-loopback host without auth_token rejected", () => {
  const c = base(); c.server.host = "0.0.0.0";
  expect(validateConfig(c)[0]).toMatch(/auth_token is required/);
});

test("template is valid yaml", async () => {
  const { parse } = await import("yaml");
  expect(() => parse(CONFIG_TEMPLATE)).not.toThrow();
});

test("negative timeout values rejected", () => {
  const c = base(); (c as any).timeout = { stream: { first_packet: -1 } };
  expect(validateConfig(c)[0]).toMatch(/timeout/);
});
test("non_stream min > max rejected", () => {
  const c = base(); (c as any).timeout = { non_stream: { by_request: { min: 100, max: 50 } } };
  expect(validateConfig(c)[0]).toMatch(/min.*max|max.*min/);
});
test("array-shaped timeout leaf rejected", () => {
  const c = base(); (c as any).timeout = { stream: { first_packet: [5000] } };
  expect(validateConfig(c)[0]).toMatch(/must be a positive number/);
});
test("non-number timeout leaf rejected", () => {
  const c = base(); (c as any).timeout = { stream: { first_packet: "5000" } };
  expect(validateConfig(c)[0]).toMatch(/must be a positive number/);
});

test("negative failover values rejected", () => {
  const c = base(); (c as any).failover = { max_retries: -1 };
  expect(validateConfig(c)[0]).toMatch(/failover\.max_retries must be a positive number/);
});

test("fractional failover counts rejected; durations stay float-allowed", () => {
  // Every counting-class field must be a whole number...
  for (const f of ["max_retries", "failure_threshold", "latency_window", "recovery_successes"]) {
    const c = base(); (c as any).failover = { [f]: 2.5 };
    expect(validateConfig(c)[0]).toMatch(new RegExp(`failover\\.${f} must be a positive integer`));
  }
  // ...while duration fields accept fractions (cooldown_ms and timeout leaves).
  const d = base(); (d as any).failover = { cooldown_ms: 300000.5 };
  expect(validateConfig(d)).toEqual([]);
  const t = base(); (t as any).timeout = { stream: { first_packet: 5000.5 } };
  expect(validateConfig(t)).toEqual([]);
});
