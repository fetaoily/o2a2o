// tests/core/timeout-calculator.test.ts
import { test, expect } from "bun:test";
import { calculateTimeout, LatencyTracker } from "../../src/core/timeout-calculator";
import { resolveTimeoutConfig } from "../../src/config/loader";
import type { AppConfig } from "../../src/config/loader";

const tc = resolveTimeoutConfig({ server: { port: 0, host: "127.0.0.1", log_level: "info" }, models: [], aliases: {}, api_keys: {} } as AppConfig);

test("default timeout when nothing special", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100, isStream: false, tc })).toBe(30000));  // 100*100=10s < min 30s

test("max_tokens estimation clamps to max", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100000, isStream: false, tc })).toBe(300000));

test("by_model overrides estimation", () => {
  const t2 = { ...tc, non_stream: { ...tc.non_stream, by_model: { big: 120000 } } };
  expect(calculateTimeout({ model: "big", maxTokens: 10, isStream: false, tc: t2 })).toBe(120000);
});

test("stream skips token estimation (min floor still applies)", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100000, isStream: true, tc })).toBe(60000)); // default

test("adaptive: 3x avg latency raises floor above base", () => {
  const lt = new LatencyTracker();
  for (let i = 0; i < 5; i++) lt.record("slow", 25000);   // avg 25s -> floor 75s > 60s default
  expect(calculateTimeout({ model: "slow", maxTokens: 100, isStream: true, tc, tracker: lt })).toBe(75000);
});

test("adaptive floor is capped by by_request.max", () => {
  const lt = new LatencyTracker();
  for (let i = 0; i < 5; i++) lt.record("slow", 200000);  // 3x = 600s > max 300s
  expect(calculateTimeout({ model: "slow", maxTokens: 100, isStream: true, tc, tracker: lt })).toBe(300000);
});
