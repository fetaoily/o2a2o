import { test, expect } from "bun:test";
import { ApiKeyPool } from "../../src/core/api-key-pool";
import { ConfigError } from "../../src/config/loader";
import { maskKey } from "../../src/utils/logger";

// Fixed-clock discrimination suite: every test isolates ONE scoring/state
// component and must fail if that component is mutated. Ordering tests put the
// expected LOSER first, so an index tie-break can never fake a pass.
// BASE uses threshold 3 / cooldown 5000 so cooldown cycles fit tests.

const BASE = { max_retries: 3, failure_threshold: 3, cooldown_ms: 5000, latency_window: 10, recovery_successes: 3 };
const cfg = (o: Partial<typeof BASE> = {}) => ({ ...BASE, ...o });

function clk(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

// Drives keyId through cooldown -> (expiry) -> degraded with cf cleared by one
// success; needs recovery_successes > 1 so the success does not promote it.
function toDegradedCf0(pool: ApiKeyPool, key: string, c: ReturnType<typeof clk>) {
  const id = maskKey(key);
  for (let i = 0; i < 3; i++) pool.recordFailure(id); // threshold 3 -> cooldown
  c.advance(5_001);
  pool.maybeRecover(); // -> degraded
  pool.recordSuccess(id, 0); // cf -> 0, still degraded
}

test("priority ordering: lower priority number wins between two healthy keys", () => {
  const c = clk();
  const worse = { key: "sk-priority-worse-aaaaaaaa-1111", priority: 20 };
  const better = { key: "sk-priority-better-bbbbbbbb-2222", priority: 10 };
  const pool = new ApiKeyPool(cfg(), [worse, better], c.now); // loser configured first
  const d = pool.select();
  expect(d.key).toBe(better.key);
  expect(d.keyId).toBe(maskKey(better.key));
  expect(d.fallback).toBe(false);
});

test("weight ordering: higher weight wins at equal priority, missing weight counts as 0", () => {
  const c = clk();
  const noWeight = { key: "sk-weight-none-aaaaaaaaaa-1111", priority: 50 };
  const weighted = { key: "sk-weight-hundred-bbbbbbbb-2222", priority: 50, weight: 100 };
  const pool = new ApiKeyPool(cfg(), [noWeight, weighted], c.now);
  expect(pool.select().key).toBe(weighted.key);
});

test("health bonus ordering: degraded (+500) loses to healthy (+1000) on equal footing yet beats a far worse-priority healthy key", () => {
  // Arrangement 1: degraded vs healthy, equal priority. Healthy must win
  // strictly; if degraded were scored as healthy (1000) the tie would fall to
  // the first-configured degraded key and fail this assertion.
  {
    const c = clk();
    const degraded = { key: "sk-health-degraded-aaaaaaaa-1111", priority: 50 };
    const healthy = { key: "sk-health-healthy-bbbbbbbb-2222", priority: 50 };
    const pool = new ApiKeyPool(cfg({ recovery_successes: 5 }), [degraded, healthy], c.now);
    toDegradedCf0(pool, degraded.key, c);
    pool.recordSuccess(maskKey(healthy.key), 0); // normalize lastUsedTime/latency of both
    expect(pool.select().key).toBe(healthy.key);
  }
  // Arrangement 2: degraded at priority 10 must outrank a healthy key that is
  // 60 priority steps better (900+500 > 300+1000); a degraded bonus of 0
  // would let the healthy key win and fail here.
  {
    const c = clk();
    const degraded = { key: "sk-health-degraded-cccccccc-3333", priority: 10 };
    const healthy = { key: "sk-health-healthy-dddddddd-4444", priority: 70 };
    const pool = new ApiKeyPool(cfg({ recovery_successes: 5 }), [degraded, healthy], c.now);
    toDegradedCf0(pool, degraded.key, c);
    pool.recordSuccess(maskKey(healthy.key), 0);
    expect(pool.select().key).toBe(degraded.key);
  }
});

test("latency penalty: higher avgLatency scores lower, saturating at the 500 cap", () => {
  // Plain ordering: 2000ms avg (penalty 200) loses to 100ms avg (penalty 10).
  {
    const c = clk();
    const slow = { key: "sk-latency-slow-aaaaaaaaaa-1111", priority: 50 };
    const fast = { key: "sk-latency-fast-bbbbbbbbbb-2222", priority: 50 };
    const pool = new ApiKeyPool(cfg(), [slow, fast], c.now);
    pool.recordSuccess(maskKey(slow.key), 2000);
    pool.recordSuccess(maskKey(fast.key), 100);
    expect(pool.select().key).toBe(fast.key);
  }
  // Cap: 9999ms saturates at 500 while 5500ms costs 550, so the slower key
  // wins; without the min(...,500) clamp the slower key would lose.
  {
    const c = clk();
    const saturated = { key: "sk-latency-cap-cccccccccc-3333", priority: 50 };
    const moderate = { key: "sk-latency-mid-dddddddddd-4444", priority: 50 };
    const pool = new ApiKeyPool(cfg(), [saturated, moderate], c.now);
    pool.recordSuccess(maskKey(saturated.key), 9999);
    pool.recordSuccess(maskKey(moderate.key), 5500);
    expect(pool.select().key).toBe(saturated.key);
  }
});

test("consecutive failures penalty: a single failure costs -100 and hands selection to the clean twin", () => {
  const c = clk();
  const failing = { key: "sk-failures-flaky-aaaaaaaa-1111", priority: 50 };
  const clean = { key: "sk-failures-clean-bbbbbbbb-2222", priority: 50 };
  const pool = new ApiKeyPool(cfg(), [failing, clean], c.now); // loser first
  pool.recordFailure(maskKey(failing.key)); // below threshold 3: still selectable
  expect(pool.snapshot()[maskKey(failing.key)].status).toBe("healthy");
  expect(pool.select().key).toBe(clean.key);
});

test("rotation bonus: select() stamps lastUsedTime so a just-used key loses to the idle twin, regaining the bonus only after 60s", () => {
  const c = clk();
  // X has the 10-point better base (priority 48 vs 49): it wins while idle,
  // loses immediately after use (pins lastUsedTime stamping and the <60s
  // window), and wins back once its delta passes 60s.
  const x = { key: "sk-rotation-exxxxxxxxx-1111", priority: 48 };
  const y = { key: "sk-rotation-yyyyyyyyyyyy-2222", priority: 49 };
  const pool = new ApiKeyPool(cfg(), [x, y], c.now);
  expect(pool.select().key).toBe(x.key);   // both pristine (+50): better base wins
  c.advance(30_000);
  expect(pool.select().key).toBe(y.key);   // x stamped: delta 30s <= 60s, no bonus (520 < 560)
  c.advance(31_000);
  expect(pool.select().key).toBe(x.key);   // x delta 61s: bonus returns (570 > 560)
  // Strict inequality at the boundary: a key used exactly 60_000ms ago must
  // NOT get the bonus. a (base 510) wins the pristine tie-break-free contest
  // only while bonus-less; with >= instead of > it would keep the bonus and
  // beat pristine b here.
  const c2 = clk(2_000_000);
  const a = { key: "sk-rotation-aaaaaaaaaaaa-3333", priority: 49 };
  const b = { key: "sk-rotation-bbbbbbbbbbbb-4444", priority: 50 };
  const pool2 = new ApiKeyPool(cfg(), [a, b], c2.now);
  expect(pool2.select().key).toBe(a.key);  // pristine: 560 > 550
  c2.advance(60_000);
  expect(pool2.select().key).toBe(b.key);  // a delta exactly 60_000: not > 60_000 (510 < 550)
});

test("latency window: only the last latency_window samples are averaged", () => {
  const c = clk();
  const a = { key: "sk-window-spiky-aaaaaaaaaa-1111", priority: 50 };
  const b = { key: "sk-window-steady-bbbbbbbbb-2222", priority: 50 };
  const pool = new ApiKeyPool(cfg({ latency_window: 2 }), [a, b], c.now);
  pool.recordSuccess(maskKey(a.key), 100);
  pool.recordSuccess(maskKey(a.key), 100);
  pool.recordSuccess(maskKey(a.key), 9000); // window keeps [100, 9000]: avg 4550, penalty 455
  pool.recordSuccess(maskKey(b.key), 4000); // penalty 400
  const snap = pool.snapshot()[maskKey(a.key)];
  expect(snap.latencySamples).toEqual([100, 9000]); // oldest sample dropped, not accumulated
  // Windowed: a (455) loses to b (400). Unwindowed, a's avg would be ~3067
  // (penalty ~307) and a would win, so the truncation is observable here.
  expect(pool.select().key).toBe(b.key);
});

test("cooldown exclusion: a cooling-down key is never selected while now < cooldownUntil", () => {
  const c = clk(500_000);
  const hot = { key: "sk-cooling-hot-aaaaaaaaaa-1111", priority: 1 };  // dominant when available
  const cold = { key: "sk-cooling-cold-bbbbbbbbb-2222", priority: 99 };
  const pool = new ApiKeyPool(cfg({ recovery_successes: 5 }), [hot, cold], c.now);
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(cold.key)); // cold cools first...
  c.advance(5_001);
  pool.maybeRecover();                              // ...recovers to degraded...
  pool.recordSuccess(maskKey(cold.key), 0);         // ...with cf cleared, still degraded
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(hot.key)); // hot cools NOW
  // hot if scored: 990 + 0 (cooldown) + 50 - 300 = 740; cold: 10 + 500 + 0 = 510.
  // Only exclusion keeps the dominant cooling key out.
  const d = pool.select();
  expect(d.keyId).toBe(maskKey(cold.key));
  expect(d.fallback).toBe(false);
  c.advance(5_001);
  pool.maybeRecover();                              // hot's cooldown expires -> degraded
  expect(pool.select().keyId).toBe(maskKey(hot.key)); // exclusion is time-based and lifts
});

test("fallback: when every key is cooling down the lowest priority number is forced with fallback=true", () => {
  const c = clk();
  const a = { key: "sk-fallback-first-aaaaaaaaa-1111", priority: 10 };
  const b = { key: "sk-fallback-second-bbbbbbbb-2222", priority: 20 };
  const pool = new ApiKeyPool(cfg(), [a, b], c.now);
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(a.key));
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(b.key));
  const d = pool.select();
  expect(d.fallback).toBe(true);
  expect(d.key).toBe(a.key); // lowest priority number, not the other cooling key
  expect(d.keyId).toBe(maskKey(a.key));
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("cooldown"); // forced attempt, no state fudge
});

test("cooldown entry: threshold consecutive failures flip status and set cooldownUntil = now + cooldown_ms", () => {
  const c = clk(1_000_000);
  const a = { key: "sk-entry-flaky-aaaaaaaaaa-1111", priority: 10 };
  const pool = new ApiKeyPool(cfg(), [a], c.now);
  pool.recordFailure(maskKey(a.key));
  pool.recordFailure(maskKey(a.key));
  let s = pool.snapshot()[maskKey(a.key)];
  expect(s.status).toBe("healthy"); // 2 < threshold 3: not yet
  expect(s.consecutiveFailures).toBe(2);
  expect(s.totalFailures).toBe(2);
  expect(s.lastFailureTime).toBe(1_000_000);
  c.advance(100);
  pool.recordFailure(maskKey(a.key));
  s = pool.snapshot()[maskKey(a.key)];
  expect(s.status).toBe("cooldown");
  expect(s.cooldownUntil).toBe(1_000_100 + 5_000); // now + cooldown_ms, exact
  expect(s.consecutiveFailures).toBe(3); // kept on entry, NOT reset
  expect(s.totalFailures).toBe(3);
});

test("maybeRecover: cooldown flips to degraded exactly at cooldownUntil (idempotent), and recovery_successes consecutive successes restore healthy", () => {
  const c = clk(1_000_000);
  const a = { key: "sk-recover-single-aaaaaaa-1111", priority: 10 };
  const pool = new ApiKeyPool(cfg(), [a], c.now);
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(a.key)); // until 1_005_000
  c.advance(4_999);
  pool.maybeRecover();
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("cooldown"); // 1ms early: no recovery
  c.advance(1); // now == cooldownUntil
  pool.maybeRecover();
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("degraded");
  const before = pool.snapshot()[maskKey(a.key)];
  pool.maybeRecover(); // idempotent: second call is a no-op
  expect(pool.snapshot()[maskKey(a.key)]).toEqual(before);
  pool.recordSuccess(maskKey(a.key), 10);
  pool.recordSuccess(maskKey(a.key), 10);
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("degraded"); // 2 < recovery_successes 3
  pool.recordSuccess(maskKey(a.key), 10);
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("healthy");
  expect(pool.snapshot()[maskKey(a.key)].avgLatency).toBe(10);
});

test("recovery counting: successes earned during cooldown do not promote after expiry", () => {
  const c = clk(1_000_000);
  const a = { key: "sk-recovery-premature-aaaaaa-1111", priority: 10 };
  const pool = new ApiKeyPool(cfg(), [a], c.now);
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(a.key)); // cooldown
  for (let i = 0; i < 5; i++) pool.recordSuccess(maskKey(a.key), 5); // fallback-style successes while cooling
  c.advance(5_001);
  pool.maybeRecover();
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("degraded"); // banked successes discarded
  pool.recordSuccess(maskKey(a.key), 5);
  pool.recordSuccess(maskKey(a.key), 5);
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("degraded"); // fresh count 2 < 3
  pool.recordSuccess(maskKey(a.key), 5);
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("healthy");
});

test("duplicate masked key id throws ConfigError; snapshot exposes no plaintext keys", () => {
  const dupA = "sk-poolzzzAAAA7777"; // same first 8 and last 4 as dupB
  const dupB = "sk-poolzzzBBBB7777";
  expect(maskKey(dupA)).toBe(maskKey(dupB));
  expect(() => new ApiKeyPool(cfg(), [{ key: dupA, priority: 1 }, { key: dupB, priority: 2 }], () => 0))
    .toThrow("duplicate key id in pool: sk-poolz...7777");
  expect(() => new ApiKeyPool(cfg(), [{ key: dupA, priority: 1 }, { key: dupB, priority: 2 }], () => 0))
    .toThrow(ConfigError);

  const secretA = "sk-verysecret-AAAA-9999";
  const secretB = "sk-verysecret-BBBB-8888";
  const pool = new ApiKeyPool(cfg(), [{ key: secretA, priority: 1 }, { key: secretB, priority: 2 }], clk().now);
  pool.recordFailure(maskKey(secretA));
  const blob = JSON.stringify(pool.snapshot());
  expect(blob).not.toContain("verysecret");
  expect(blob).not.toContain(secretA);
  expect(blob).not.toContain(secretB);
  const snap = pool.snapshot();
  expect(Object.keys(snap).filter((k) => k !== "keys").sort()).toEqual([maskKey(secretA), maskKey(secretB)].sort());
  expect(snap.keys.sort()).toEqual([maskKey(secretA), maskKey(secretB)].sort());
});

test("empty pool: select throws ConfigError instead of returning an undefined decision", () => {
  const pool = new ApiKeyPool(cfg(), [], () => 0);
  expect(() => pool.select()).toThrow(ConfigError);
});

test("resetKey: cooldown cleared, failures zeroed, latency history kept, selection order restored", () => {
  const c = clk(1_000_000);
  const a = { key: "sk-reset-flaky-aaaaaaaaa-1111", priority: 10 };
  const b = { key: "sk-reset-clean-bbbbbbbbb-2222", priority: 20 };
  const pool = new ApiKeyPool(cfg({ recovery_successes: 5 }), [a, b], c.now);
  pool.recordSuccess(maskKey(a.key), 120);
  for (let i = 0; i < 3; i++) pool.recordFailure(maskKey(a.key)); // threshold 3 -> cooldown
  expect(pool.snapshot()[maskKey(a.key)].status).toBe("cooldown");
  expect(pool.select().keyId).toBe(maskKey(b.key)); // a excluded while cooling

  expect(pool.resetKey(maskKey(a.key))).toBe(true);
  const s = pool.snapshot()[maskKey(a.key)];
  expect(s.status).toBe("healthy");
  expect(s.consecutiveFailures).toBe(0);
  expect(s.cooldownUntil).toBe(0);
  expect(s.totalFailures).toBe(3);         // lifetime counter is kept
  expect(s.latencySamples).toEqual([120]); // history kept through the reset
  expect(s.avgLatency).toBe(120);
  expect(pool.select().keyId).toBe(maskKey(a.key)); // priority order restored over b
});

test("resetKey: unknown keyId is a no-op returning false", () => {
  const pool = new ApiKeyPool(cfg(), [{ key: "sk-reset-unknown-aaaaaaaa-1111", priority: 10 }], clk().now);
  const before = pool.snapshot();
  expect(pool.resetKey("sk-no-such-key-9999")).toBe(false);
  expect(pool.snapshot()).toEqual(before);
});
