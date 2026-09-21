import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  forwardToUpstream, forwardWithFailover, isRetryableUpstreamError,
  KeyPoolRegistry, UpstreamError,
} from "../../src/core/forwarder";
import { handleGatewayRequest } from "../../src/core/unified-converter";
import { ParamError } from "../../src/converters/chat";
import type { AppConfig, ModelConfig } from "../../src/config/loader";
import { maskKey } from "../../src/utils/logger";

// Long distinct keys everywhere: maskKey collapses short keys to "***", which
// would collide inside a pool (duplicate keyId -> ConfigError).
const K_PRIMARY = "sk-primary-key-aaaaaaaa-1111";
const K_SECONDARY = "sk-secondary-key-bbbbbbbb-2222";
const K_GLOBAL = "sk-global-fallback-cccccccc-3333";
const K_ANT_P1 = "sk-ant-priority1-dddddddd-4444";
const K_ANT_P2 = "sk-ant-priority2-eeeeeeee-5555";
const K_CONFIG = "sk-pool-config-key-ffffffff-6666";
const K_HDR = "sk-dynamic-header-gggggggg-7777";
const K_BODY = "sk-dynamic-body-hhhhhhhh-8888";

const server = { port: 0, host: "127.0.0.1", log_level: "info" };
const DEF_FAILOVER = { max_retries: 3, failure_threshold: 3, cooldown_ms: 300000, latency_window: 10, recovery_successes: 3 };

// Registry/selection fixture (M2 resolveKey semantics, migrated to pools):
// priority 1 beats priority 2; per-model scoping; provider-wide global for
// keyless models.
function regCfg(): AppConfig {
  return {
    server,
    models: [
      { name: "gpt-4o", provider: "openai", api_keys: [{ key: K_SECONDARY, priority: 2 }, { key: K_PRIMARY, priority: 1 }] },
      { name: "claude", provider: "anthropic", api_keys: [{ key: K_ANT_P2, priority: 2 }, { key: K_ANT_P1, priority: 1 }] },
      { name: "gpt-x", provider: "openai", api_keys: [] },
    ],
    aliases: {},
    api_keys: { openai: K_GLOBAL },
    failover: { ...DEF_FAILOVER },
  };
}

// Single-config-key fixture for the dynamic-key / strip gateway tests.
function dynCfg(): AppConfig {
  return {
    server,
    models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: K_CONFIG, priority: 1 }] }],
    aliases: {},
    api_keys: {},
    failover: { ...DEF_FAILOVER },
  };
}

const gpt4o: ModelConfig = regCfg().models[0];

// ---------------------------------------------------------------------------
// Retryable-error classification (Task 4 reuses this from the stream path)
// ---------------------------------------------------------------------------

test("isRetryableUpstreamError: 5xx/429/401/403 and network failures retry; other 4xx and non-upstream errors do not", () => {
  for (const status of [500, 502, 503, 429, 401, 403])
    expect(isRetryableUpstreamError(new UpstreamError(status, {}))).toBe(true);
  for (const status of [400, 402, 404, 422])
    expect(isRetryableUpstreamError(new UpstreamError(status, {}))).toBe(false);
  expect(isRetryableUpstreamError(new TypeError("fetch failed"))).toBe(true);
  const abort = new Error("the operation was aborted");
  abort.name = "AbortError";
  expect(isRetryableUpstreamError(abort)).toBe(true);
  expect(isRetryableUpstreamError(new ParamError("invalid parameter"))).toBe(false);
  expect(isRetryableUpstreamError(new Error("generic"))).toBe(false);
  expect(isRetryableUpstreamError("a string")).toBe(false);
  expect(isRetryableUpstreamError(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// KeyPoolRegistry: per-cfg caching, per-model pools, global-fallback key
// ---------------------------------------------------------------------------

test("KeyPoolRegistry.from reuses one registry per cfg and isolates different cfgs", () => {
  const a = regCfg();
  const b = regCfg();
  expect(KeyPoolRegistry.from(a)).toBe(KeyPoolRegistry.from(a));
  expect(KeyPoolRegistry.from(a)).not.toBe(KeyPoolRegistry.from(b));
});

test("poolFor builds one pool per model and selection follows key priority", () => {
  const cfg = regCfg();
  const registry = new KeyPoolRegistry(cfg);
  expect(registry.poolFor(cfg.models[0]).select().key).toBe(K_PRIMARY);   // priority 1 wins
  expect(registry.poolFor(cfg.models[1]).select().key).toBe(K_ANT_P1);    // scoped to the claude model
  const second: ModelConfig = { name: "gpt-4o-mini", provider: "openai", api_keys: [{ key: K_CONFIG, priority: 1 }] };
  expect(registry.poolFor(second).select().key).toBe(K_CONFIG);           // not pooled across models
});

test("model without api_keys falls back to the provider-wide global key as a single-key pool", () => {
  const cfg = regCfg();
  const registry = new KeyPoolRegistry(cfg);
  const keyless: ModelConfig = { name: "gpt-x", provider: "openai", api_keys: [] };
  const pool = registry.poolFor(keyless);
  expect(pool.select().key).toBe(K_GLOBAL);
  expect(Object.keys(pool.snapshot()).filter((k) => k !== "keys")).toHaveLength(1);
});

test("no keys anywhere: poolFor throws 'no api key available for provider X'", () => {
  const cfg: AppConfig = {
    server,
    models: [{ name: "nope", provider: "anthropic", api_keys: [] }],
    aliases: {},
    api_keys: {},
  };
  expect(() => new KeyPoolRegistry(cfg).poolFor(cfg.models[0]))
    .toThrow(/no api key available for provider anthropic/);
});

// ---------------------------------------------------------------------------
// forwardWithFailover: cross-key retry loop over mocked fetch
// ---------------------------------------------------------------------------

const okRes = (body: unknown = { id: "up-1" }) => new Response(JSON.stringify(body), { status: 200 });
const errRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

interface CapturedCall { headers: Record<string, string>; body: Record<string, unknown> }

// Installs a global.fetch that records every call (auth header + parsed body)
// and answers via `handler(callNumber, body, headers)`. A thrown handler error
// rejects the fetch promise (network-failure simulation).
function captureFetch(handler: (n: number, body: Record<string, unknown>, headers: Record<string, string>) => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  global.fetch = (async (_url: unknown, init: any) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);
    calls.push({ headers, body });
    return handler(calls.length, body, headers);
  }) as any;
  return calls;
}

const FO = { provider: "openai", endpoint: "/v1/chat/completions" } as const;

test("failover: best-scoring key fails retryably, second key serves the request", async () => {
  const cfg = regCfg();
  const calls = captureFetch((n) => (n === 1 ? errRes(429, { error: "rate limited" }) : okRes()));
  const result = await forwardWithFailover({
    ...FO, body: { model: "gpt-4o" }, registry: new KeyPoolRegistry(cfg),
    model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_PRIMARY}`);   // priority 1 selected first
  expect(calls[1].headers.authorization).toBe(`Bearer ${K_SECONDARY}`); // switch on retryable failure
  expect(result.keyId).toBe(maskKey(K_SECONDARY));
  expect(result.fallback).toBe(false);
  expect(result.response.status).toBe(200);
});

test("accounting persists through the registry: a failed key demotes in later requests", async () => {
  const cfg = regCfg();
  const registry = KeyPoolRegistry.from(cfg);
  const calls = captureFetch((n) => (n === 1 ? errRes(429, { error: "rate limited" }) : okRes()));
  const first = await forwardWithFailover({
    ...FO, body: { model: "gpt-4o" }, registry,
    model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
  });
  expect(first.keyId).toBe(maskKey(K_SECONDARY));
  // Request 2 must remember the primary key's failure: the secondary (whose
  // score overtook the demoted primary) is selected first.
  const second = await forwardWithFailover({
    ...FO, body: { model: "gpt-4o" }, registry,
    model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
  });
  expect(second.keyId).toBe(maskKey(K_SECONDARY));
  expect(calls.map((c) => c.headers.authorization)).toEqual([
    `Bearer ${K_PRIMARY}`, `Bearer ${K_SECONDARY}`,   // request 1
    `Bearer ${K_SECONDARY}`,                          // request 2: demotion remembered
  ]);
});

test("retries exhausted throws the last UpstreamError with its status and body", async () => {
  const cfg = regCfg();
  const calls = captureFetch((n) => errRes(429, n === 1 ? { error: "first" } : { error: "second" }));
  try {
    await forwardWithFailover({
      ...FO, body: { model: "gpt-4o" }, registry: new KeyPoolRegistry(cfg),
      model: cfg.models[0], timeoutMs: 1000, maxRetries: 2,
    });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(429);
    expect((e as UpstreamError).body).toEqual({ error: "second" });
  }
  expect(calls).toHaveLength(2); // maxRetries bounds total attempts
});

test("non-retryable 400 does not consume another key", async () => {
  const cfg = regCfg();
  const calls = captureFetch(() => errRes(400, { error: "bad request" }));
  try {
    await forwardWithFailover({
      ...FO, body: { model: "gpt-4o" }, registry: new KeyPoolRegistry(cfg),
      model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
    });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(400);
  }
  expect(calls).toHaveLength(1); // thrown immediately after one attempt
});

test("network failure (fetch TypeError) retries on the next key", async () => {
  const cfg = regCfg();
  const calls = captureFetch((n) => {
    if (n === 1) throw new TypeError("fetch failed");
    return okRes();
  });
  const result = await forwardWithFailover({
    ...FO, body: { model: "gpt-4o" }, registry: new KeyPoolRegistry(cfg),
    model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
  });
  expect(calls).toHaveLength(2);
  expect(calls[1].headers.authorization).toBe(`Bearer ${K_SECONDARY}`);
  expect(result.response.status).toBe(200);
});

test("successful attempts feed key latency accounting", async () => {
  const cfg = regCfg();
  captureFetch(() => okRes());
  const registry = new KeyPoolRegistry(cfg);
  await forwardWithFailover({
    ...FO, body: { model: "gpt-4o" }, registry,
    model: cfg.models[0], timeoutMs: 1000, maxRetries: 3,
  });
  const snap = registry.poolFor(cfg.models[0]).snapshot();
  expect(snap[maskKey(K_PRIMARY)].latencySamples).toHaveLength(1);
  expect(snap[maskKey(K_PRIMARY)].consecutiveFailures).toBe(0);
  expect(snap[maskKey(K_SECONDARY)].totalFailures).toBe(0);
});

test("all keys cooling: the fallback key serves with fallback=true", async () => {
  // failure_threshold 1 + long cooldown: request 1 burns both keys (500 then
  // 429, retries exhausted), request 2 force-tries the lowest priority number.
  const cfg: AppConfig = {
    server,
    models: [{ name: "m", provider: "openai", api_keys: [{ key: K_PRIMARY, priority: 1 }, { key: K_SECONDARY, priority: 2 }] }],
    aliases: {},
    api_keys: {},
    failover: { max_retries: 2, failure_threshold: 1, cooldown_ms: 60000, latency_window: 10, recovery_successes: 3 },
  };
  const registry = new KeyPoolRegistry(cfg);
  const calls = captureFetch((n) => (n === 1 ? errRes(500, { error: "boom" }) : n === 2 ? errRes(429, { error: "limited" }) : okRes()));
  try {
    await forwardWithFailover({
      ...FO, body: { model: "m" }, registry, model: cfg.models[0], timeoutMs: 1000, maxRetries: 2,
    });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(429);
  }
  const result = await forwardWithFailover({
    ...FO, body: { model: "m" }, registry, model: cfg.models[0], timeoutMs: 1000, maxRetries: 2,
  });
  expect(result.fallback).toBe(true);
  expect(result.keyId).toBe(maskKey(K_PRIMARY)); // lowest priority number force-tried
  expect(calls).toHaveLength(3);                 // 2 attempts in request 1, 1 fallback attempt in request 2
  expect(calls[2].headers.authorization).toBe(`Bearer ${K_PRIMARY}`);
  expect(result.response.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Gateway non-stream path: dynamic keys bypass the pool; o2a2o_keys stripped
// ---------------------------------------------------------------------------

const CHAT_PATH = "/v1/chat/completions";
const chatBody = () => ({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });

test("dynamic header key bypasses the pool: used directly, single attempt, no accounting", async () => {
  const cfg = dynCfg();
  const registry = KeyPoolRegistry.from(cfg);
  const pool = registry.poolFor(cfg.models[0]);
  pool.recordFailure(maskKey(K_CONFIG)); // pre-dirty so any extra accounting would show
  const before = pool.snapshot();
  const calls = captureFetch(() => errRes(500, { error: "boom" }));
  try {
    await handleGatewayRequest(cfg, CHAT_PATH, chatBody(), { "x-o2a2o-openai-key": K_HDR });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(500);
  }
  expect(calls).toHaveLength(1); // no retry on a dynamic key
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_HDR}`);
  expect(pool.snapshot()).toEqual(before); // pool state untouched
});

test("body o2a2o_keys key is used directly and stripped from the upstream body", async () => {
  const cfg = dynCfg();
  const registry = KeyPoolRegistry.from(cfg);
  const pool = registry.poolFor(cfg.models[0]);
  const before = pool.snapshot();
  const calls = captureFetch(() => okRes());
  const out = await handleGatewayRequest(cfg, CHAT_PATH,
    { ...chatBody(), o2a2o_keys: { openai: K_BODY } }, {});
  expect(out.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_BODY}`);
  expect(calls[0].body.o2a2o_keys).toBeUndefined();
  expect(calls[0].body.messages).toEqual(chatBody().messages);
  expect(pool.snapshot()).toEqual(before);
});

test("header key wins over body key", async () => {
  const cfg = dynCfg();
  const calls = captureFetch(() => okRes());
  await handleGatewayRequest(cfg, CHAT_PATH,
    { ...chatBody(), o2a2o_keys: { openai: K_BODY } }, { "x-o2a2o-openai-key": K_HDR });
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_HDR}`);
});

test("empty-string header key falls through to the pool key", async () => {
  const cfg = dynCfg();
  const calls = captureFetch(() => okRes());
  await handleGatewayRequest(cfg, CHAT_PATH, chatBody(), { "x-o2a2o-openai-key": "" });
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_CONFIG}`);
});

test("o2a2o_keys is stripped even when it holds no key for the target provider", async () => {
  const cfg = dynCfg();
  const calls = captureFetch(() => okRes());
  await handleGatewayRequest(cfg, CHAT_PATH,
    { ...chatBody(), o2a2o_keys: { anthropic: K_BODY } }, {});
  expect(calls[0].headers.authorization).toBe(`Bearer ${K_CONFIG}`); // pool key served
  expect(calls[0].body.o2a2o_keys).toBeUndefined();                  // strip ALWAYS, even for pool keys
});

test("no key anywhere surfaces 'no api key available' from the gateway request", async () => {
  const cfg: AppConfig = {
    server,
    models: [{ name: "nope", provider: "anthropic", api_keys: [] }],
    aliases: {},
    api_keys: {},
  };
  captureFetch(() => okRes());
  await expect(handleGatewayRequest(cfg, "/v1/messages", { model: "nope", max_tokens: 1, messages: [] }, {}))
    .rejects.toThrow(/no api key available for provider anthropic/);
});

beforeEach(() => { mock.restore(); });
// global.fetch is assigned directly below; mock.restore() does not undo direct
// assignments, so restore it explicitly to keep the leak out of later test files.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

test("forwardToUpstream sends provider-correct headers; non-2xx throws UpstreamError", async () => {
  const fetchMock = mock(async (url: any, init: any) => {
    if (String(url).includes("anthropic")) {
      expect(init.headers["x-api-key"]).toBe("sk-ant");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "rate limited", type: "requests" } }), { status: 429 });
  });
  global.fetch = fetchMock as any;
  process.env.O2A2O_UPSTREAM_ANTHROPIC = "http://anthropic-mock:9";
  const ok = await forwardToUpstream({ provider: "anthropic", endpoint: "/v1/messages", body: {} as any, key: "sk-ant" });
  expect(ok.status).toBe(200);
  try {
    await forwardToUpstream({ provider: "openai", endpoint: "/v1/chat/completions", body: {} as any, key: "sk-x" });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(429);
  }
  delete process.env.O2A2O_UPSTREAM_ANTHROPIC;
});
