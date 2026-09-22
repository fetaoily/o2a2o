import { test, expect } from "bun:test";
import { modelsBody, checkAuth, healthKeysBody, resolveKeyId } from "../../src/core/models-endpoint";
import { KeyPoolRegistry } from "../../src/core/forwarder";
import { maskKey } from "../../src/utils/logger";
import { ConfigError } from "../../src/config/loader";
import type { AppConfig } from "../../src/config/loader";

const cfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "k", priority: 1 }] }],
  aliases: {}, api_keys: {},
};

test("S10 openai shape by default", () => {
  const b = modelsBody(cfg, false) as any;
  expect(b.object).toBe("list");
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", object: "model", owned_by: "openai" });
});
test("S10 anthropic shape on demand", () => {
  const b = modelsBody(cfg, true) as any;
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", type: "model", display_name: "gpt-4o" });
  expect(b.has_more).toBe(false);
});
test("auth: token configured -> Bearer required", () => {
  const c = { ...cfg, server: { ...cfg.server, auth_token: "t0ken" } };
  expect(checkAuth(c, { authorization: "Bearer t0ken" })).toBe(true);
  expect(checkAuth(c, {})).toBe(false);
  expect(checkAuth(c, { authorization: "Bearer wrong" })).toBe(false);
});
test("auth: no token configured -> always pass", () =>
  expect(checkAuth(cfg, {})).toBe(true));

// ---------------------------------------------------------------------------
// M3 Task 5: /health/keys body + /admin/keys/:keyId/reset keyId resolution
// ---------------------------------------------------------------------------

const K_PRIMARY = "sk-health-primary-1111";
const K_BACKUP = "sk-health-backup-2222";

// Two-key model plus a keyless+globalless model; failover explicitly set so
// the driven cooldown lasts far longer than the test (no flakes) while
// cooldownRemaining stays assertable.
const poolCfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [
    { name: "gpt-4o", provider: "openai", api_keys: [{ key: K_PRIMARY, priority: 1 }, { key: K_BACKUP, priority: 2 }] },
    { name: "nokey", provider: "openai", api_keys: [] },
  ],
  aliases: {}, api_keys: {},
  failover: { max_retries: 3, failure_threshold: 3, cooldown_ms: 60_000, latency_window: 10, recovery_successes: 3 },
};

test("healthKeysBody: masked per-key states with cooldownRemaining after maybeRecover; keyless model appears as {}", () => {
  const pool = KeyPoolRegistry.from(poolCfg).poolFor(poolCfg.models[0]); // same registry the endpoint reads
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(K_PRIMARY));     // threshold 3 -> 60s cooldown
  const body = healthKeysBody(poolCfg) as any;
  expect(typeof body.timestamp).toBe("number");
  const s = body.models["gpt-4o"][maskKey(K_PRIMARY)];
  expect(s.status).toBe("cooldown");
  expect(s.consecutiveFailures).toBe(3);
  expect(s.totalFailures).toBe(3);
  expect(s.cooldownRemaining).toBeGreaterThan(0);
  expect(s.cooldownRemaining).toBeLessThanOrEqual(60_000);
  expect(body.models["gpt-4o"][maskKey(K_BACKUP)]).toMatchObject({ status: "healthy", consecutiveFailures: 0, cooldownRemaining: 0 });
  const blob = JSON.stringify(body);
  expect(blob).not.toContain(K_PRIMARY);                    // masked output only, no plaintext
  expect(blob).not.toContain(K_BACKUP);
  expect(body.models["nokey"]).toEqual({});                 // stated choice: keyless+globalless model appears as {}
});

test("resolveKeyId: finds the owning pool by masked id across models; unknown id -> undefined", () => {
  const found = resolveKeyId(poolCfg, maskKey(K_BACKUP));
  expect(found).toBeDefined();
  expect(found!.snapshot().keys).toContain(maskKey(K_BACKUP));
  expect(resolveKeyId(poolCfg, "sk-no-such-key-9999")).toBeUndefined();
});

// Only the keyless case may render an empty entry: a duplicate masked key id
// is a genuinely broken config and must fail the health endpoint loudly, not
// masquerade as an empty inventory.
test("healthKeysBody: duplicate key ids propagate instead of an empty entry", () => {
  const dupA = "sk-hc-dupAAAA-7777";
  const dupB = "sk-hc-dupBBBB-7777";
  expect(maskKey(dupA)).toBe(maskKey(dupB)); // same first 8 and last 4
  const bad: AppConfig = {
    ...poolCfg,
    models: [{ name: "dup", provider: "openai", api_keys: [{ key: dupA, priority: 1 }, { key: dupB, priority: 2 }] }],
  };
  expect(() => healthKeysBody(bad)).toThrow(/duplicate key id in pool/);
  expect(() => healthKeysBody(bad)).toThrow(ConfigError);
});

// Any non-keyless failure (injected here as a TypeError) must escape
// healthKeysBody — no blanket catch may turn a broken pool into `{}`.
test("healthKeysBody: a non-ConfigError from the pool propagates", () => {
  const boom = {
    poolFor: () => { throw new TypeError("boom"); },
  } as unknown as KeyPoolRegistry;
  expect(() => healthKeysBody(poolCfg, { registry: boom })).toThrow(TypeError);
  expect(() => healthKeysBody(poolCfg, { registry: boom })).toThrow("boom");
});
