// ApiKeyPool: pure-logic health pool for key failover (M3).
// No I/O, no timers on the real clock (now is injectable), no network.
// Invariant: plaintext keys never leave the pool except through select(),
// which hands the chosen key to the caller for the upstream request.
// Accounting, snapshots and logs use keyId = maskKey(key) only.

import { ConfigError, type ApiKeyConfig, type FailoverConfig } from "../config/loader";
import { maskKey } from "../utils/logger";

export type KeyHealthStatus = "healthy" | "degraded" | "cooldown";

export interface KeyState {
  key: string; // plaintext, never exposed by snapshot()
  status: KeyHealthStatus;
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureTime: number;
  lastUsedTime: number;
  avgLatency: number;
  latencySamples: number[];
  cooldownUntil: number;
}

export interface KeyDecision { key: string; keyId: string; fallback: boolean }

// Scoring constants (spec 7.2). Score is "higher is better".
const HEALTHY_BONUS = 1000;
const DEGRADED_BONUS = 500; // cooldown contributes 0
const LATENCY_PENALTY_CAP = 500;
const LATENCY_PENALTY_DIVISOR = 10;
const FAILURE_PENALTY = 100;
const ROTATION_AFTER_MS = 60_000;
const ROTATION_BONUS = 50;

interface PoolEntry {
  keyId: string;
  cfg: ApiKeyConfig;
  st: KeyState;
  // consecutive successes since the key entered degraded; drives promotion
  // back to healthy and is reset on every cooldown->degraded transition and
  // on any failure (a failure breaks the consecutive run).
  degradedWins: number;
}

export class ApiKeyPool {
  private cfg: FailoverConfig;
  private now: () => number;
  // Map preserves insertion order, so iteration is configuration order and
  // the strict > in select() breaks score ties toward the earlier key.
  private entries = new Map<string, PoolEntry>();

  constructor(cfg: FailoverConfig, keys: ApiKeyConfig[], now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
    for (const k of keys) {
      const keyId = maskKey(k.key);
      if (this.entries.has(keyId)) throw new ConfigError(`duplicate key id in pool: ${keyId}`);
      this.entries.set(keyId, {
        keyId,
        cfg: k,
        degradedWins: 0,
        st: {
          key: k.key,
          status: "healthy",
          consecutiveFailures: 0,
          totalFailures: 0,
          lastFailureTime: 0,
          lastUsedTime: 0,
          avgLatency: 0,
          latencySamples: [],
          cooldownUntil: 0,
        },
      });
    }
  }

  // Highest-scoring key whose cooldown has expired. When every key is still
  // cooling down, force-tries the lowest priority number with fallback=true.
  select(): KeyDecision {
    const now = this.now();
    let best: PoolEntry | undefined;
    let bestScore = -Infinity;
    for (const e of this.entries.values()) {
      if (e.st.cooldownUntil > now) continue; // cooling down: excluded
      const s = this.score(e, now);
      if (s > bestScore) { bestScore = s; best = e; } // strict >: earlier key wins ties
    }
    let fallback = false;
    if (!best) {
      for (const e of this.entries.values()) {
        if (!best || e.cfg.priority < best.cfg.priority) best = e;
      }
      if (!best) throw new ConfigError("cannot select from an empty key pool");
      fallback = true;
    }
    best.st.lastUsedTime = now;
    return { key: best.st.key, keyId: best.keyId, fallback };
  }

  recordSuccess(keyId: string, latencyMs: number): void {
    const e = this.entries.get(keyId);
    if (!e) return;
    const now = this.now();
    const st = e.st;
    st.consecutiveFailures = 0;
    st.latencySamples.push(latencyMs);
    if (st.latencySamples.length > this.cfg.latency_window) {
      st.latencySamples.splice(0, st.latencySamples.length - this.cfg.latency_window);
    }
    st.avgLatency = st.latencySamples.length
      ? st.latencySamples.reduce((a, b) => a + b, 0) / st.latencySamples.length
      : 0;
    st.lastUsedTime = now;
    if (st.status === "degraded") {
      e.degradedWins += 1;
      if (e.degradedWins >= this.cfg.recovery_successes) {
        st.status = "healthy";
        e.degradedWins = 0;
      }
    }
  }

  recordFailure(keyId: string): void {
    const e = this.entries.get(keyId);
    if (!e) return;
    const now = this.now();
    const st = e.st;
    st.consecutiveFailures += 1;
    st.totalFailures += 1;
    st.lastFailureTime = now;
    e.degradedWins = 0; // a failure breaks the consecutive-success run
    if (st.consecutiveFailures >= this.cfg.failure_threshold) {
      st.status = "cooldown";
      st.cooldownUntil = now + this.cfg.cooldown_ms;
    }
  }

  // Cooldown expiry sweep; the pool owner calls this before select/snapshot.
  // Idempotent and O(keys), no timers.
  maybeRecover(): void {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.st.status === "cooldown" && e.st.cooldownUntil <= now) {
        e.st.status = "degraded";
        e.degradedWins = 0; // recovery count starts fresh in degraded
      }
    }
  }

  // /health/keys data source: keyed by masked keyId, plaintext key omitted.
  // Object.assign yields the Record & { keys } intersection without a cast.
  snapshot(): Record<string, Omit<KeyState, "key">> & { keys: string[] } {
    const states: Record<string, Omit<KeyState, "key">> = {};
    for (const e of this.entries.values()) {
      states[e.keyId] = {
        status: e.st.status,
        consecutiveFailures: e.st.consecutiveFailures,
        totalFailures: e.st.totalFailures,
        lastFailureTime: e.st.lastFailureTime,
        lastUsedTime: e.st.lastUsedTime,
        avgLatency: e.st.avgLatency,
        latencySamples: [...e.st.latencySamples],
        cooldownUntil: e.st.cooldownUntil,
      };
    }
    return Object.assign(states, { keys: [...this.entries.keys()] });
  }

  // score = (100-priority)*10 + weight + healthBonus - min(avgLatency/10, 500)
  //         - consecutiveFailures*100 + (idle > 60s ? 50 : 0)
  private score(e: PoolEntry, now: number): number {
    const st = e.st;
    const health = st.status === "healthy" ? HEALTHY_BONUS : st.status === "degraded" ? DEGRADED_BONUS : 0;
    return (100 - e.cfg.priority) * 10
      + (e.cfg.weight ?? 0)
      + health
      - Math.min(st.avgLatency / LATENCY_PENALTY_DIVISOR, LATENCY_PENALTY_CAP)
      - st.consecutiveFailures * FAILURE_PENALTY
      + (now - st.lastUsedTime > ROTATION_AFTER_MS ? ROTATION_BONUS : 0);
  }
}
