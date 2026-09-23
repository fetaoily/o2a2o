// Upstream forwarding with per-model key pools (M3).
// Dynamic keys (request header / body.o2a2o_keys) bypass the pool entirely:
// they are used per-request with a single attempt and no pool accounting.
// Configured keys live in one ApiKeyPool per model (priority order, health
// scoring, cooldown); forwardWithFailover drives the cross-key retry loop and
// feeds successes/failures back into the pool. Config keys with an empty
// string count as absent (M2 truthiness preserved); a keyless model falls back
// to the provider-wide global key, and with neither it throws.
// Upstream timeout defaults to UPSTREAM_TIMEOUT_MS; callers may pass a
// calculated timeoutMs instead.
import type { AppConfig, ApiKeyConfig, FailoverConfig, ModelConfig } from "../config/loader";
import { ConfigError, resolveFailoverConfig } from "../config/loader";
import { ApiKeyPool } from "./api-key-pool";
import { log, warn, error, maskKey } from "../utils/logger";

export type Provider = "openai" | "anthropic";

// Thrown by poolFor when a model has neither model keys nor a provider-wide
// global key. A ConfigError subclass so the health-key inventory can keep such
// a model as an empty entry (a visible misconfiguration) while every other
// pool failure — duplicate key id, anything else — propagates loudly.
export class NoKeysConfigError extends ConfigError {}

export class UpstreamError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`upstream returned status ${status}`);
    this.name = "UpstreamError";
  }
}

export const UPSTREAM_TIMEOUT_MS = 60_000;

// Runtime capability probe (live-test hardening Task 1): AbortSignal.any
// composes the client signal with the per-request timeout controller natively.
// Verified available on Bun 1.3.7; a runtime without it falls back to a manual
// {once:true} listener forwarded onto the timeout controller.
const HAS_ABORT_SIGNAL_ANY =
  typeof AbortSignal === "function" && typeof AbortSignal.any === "function";

// A client disconnect surfaced as a terminal abort. Distinct from the timeout
// abort only by decision site: the request signal fired, so the retry loop
// must neither retry nor touch key accounting (a client disconnect is not an
// upstream fault).
export function clientAbortError(): Error {
  const e = new Error("client disconnected");
  e.name = "AbortError";
  return e;
}

export function upstreamBase(provider: Provider): string {
  return provider === "openai"
    ? (process.env.O2A2O_UPSTREAM_OPENAI ?? "https://api.openai.com")
    : (process.env.O2A2O_UPSTREAM_ANTHROPIC ?? "https://api.anthropic.com");
}

// Gateway method endpoints. With a per-model base_url the leading "/v1" is
// dropped and the remainder is appended to the base (live-test hardening
// Task 2).
export type GatewayEndpoint = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";

// The single upstream URL choke point. Without base_url the provider's env
// override / default origin (origin only, no version segment) is joined with
// the full gateway endpoint — byte-for-byte the historical shape. With a
// base_url the model supplies the FULL prefix including its version segment
// (SDK convention, e.g. Zhipu's "https://open.bigmodel.cn/api/paas/v4") and
// the endpoint contributes its method path without "/v1". Precedence:
// model.base_url > O2A2O_UPSTREAM_* env override > provider default.
export function resolveUpstreamUrl(opts: { provider: Provider; endpoint: GatewayEndpoint; baseUrl?: string }): string {
  if (!opts.baseUrl) return upstreamBase(opts.provider) + opts.endpoint;
  return opts.baseUrl.replace(/\/+$/, "") + opts.endpoint.replace(/^\/v1/, "");
}

// Cross-key retry classification (D4): network failures and 5xx/429/401/403
// switch keys; every other UpstreamError (4xx) and any non-upstream error
// (ParamError etc.) surfaces to the caller immediately. The stream path (M3
// Task 4) reuses this for its pre-first-packet retry window.
export function isRetryableUpstreamError(e: unknown): boolean {
  if (e instanceof UpstreamError)
    return e.status >= 500 || e.status === 429 || e.status === 401 || e.status === 403;
  if (e instanceof TypeError) return true;       // fetch network failure
  if (e instanceof Error && e.name === "AbortError") return true; // timeout abort
  return false;
}

// One pool per model, lazily constructed. `from(cfg)` caches one registry per
// config object in a module-level WeakMap, so pool state persists across
// requests for a served config while distinct cfg objects (tests, reloads)
// stay isolated.
const REGISTRIES = new WeakMap<AppConfig, KeyPoolRegistry>();

export class KeyPoolRegistry {
  private pools = new Map<string, ApiKeyPool>();
  private failover: FailoverConfig;

  constructor(private cfg: AppConfig) {
    this.failover = resolveFailoverConfig(cfg);
  }

  static from(cfg: AppConfig): KeyPoolRegistry {
    let registry = REGISTRIES.get(cfg);
    if (!registry) {
      registry = new KeyPoolRegistry(cfg);
      REGISTRIES.set(cfg, registry);
    }
    return registry;
  }

  poolFor(model: ModelConfig): ApiKeyPool {
    let pool = this.pools.get(model.name);
    if (!pool) {
      const keys: ApiKeyConfig[] = model.api_keys.filter((k) => k.key); // "" counts as absent (M2)
      if (!keys.length) {
        const globalKey = this.cfg.api_keys[model.provider];
        if (globalKey) keys.push({ key: globalKey, priority: 100, weight: 0 });
      }
      if (!keys.length) throw new NoKeysConfigError(`no api key available for provider ${model.provider}`);
      pool = new ApiKeyPool(this.failover, keys);
      this.pools.set(model.name, pool);
    }
    return pool;
  }
}

// Non-stream forward with cross-key failover: at most maxRetries total
// attempts, each selecting the pool's best available key. Success records the
// key's latency and returns; a retryable (key-level) failure is recorded and
// retried on the next key, a non-retryable (request-level) one is thrown
// without recording (UpstreamError keeps the failing attempt's status/body).
export async function forwardWithFailover(opts: {
  provider: Provider;
  endpoint: GatewayEndpoint;
  body: Record<string, unknown>;
  registry: KeyPoolRegistry;
  model: ModelConfig;
  timeoutMs: number;
  maxRetries: number;
  accept?: string;
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<{ response: Response; keyId: string; fallback: boolean }> {
  const pool = opts.registry.poolFor(opts.model); // throws when no key is configured at all
  let lastError: unknown;
  const attempts = Math.max(1, opts.maxRetries); // always at least one attempt
  for (let attempt = 0; attempt < attempts; attempt++) {
    // A client disconnect is terminal: no attempt, no retry, no accounting.
    if (opts.signal?.aborted) throw clientAbortError();
    pool.maybeRecover();
    const decision = pool.select();
    if (decision.fallback) warn(`all keys cooling down: force-trying ${decision.keyId}`);
    const start = Date.now();
    try {
      const response = await forwardToUpstream({
        provider: opts.provider, endpoint: opts.endpoint, body: opts.body,
        key: decision.key, timeoutMs: opts.timeoutMs, accept: opts.accept, signal: opts.signal,
        baseUrl: opts.baseUrl,
      });
      pool.recordSuccess(decision.keyId, Date.now() - start);
      return { response, keyId: decision.keyId, fallback: decision.fallback };
    } catch (e) {
      lastError = e;
      // A client disconnect is not an upstream fault (controller ruling).
      // Checked BEFORE the retry classification so an abort can never reach
      // isRetryableUpstreamError's AbortError branch (which would demote the
      // key): no retry, no max_retries consumption, no accounting.
      if (opts.signal?.aborted) throw clientAbortError();
      // Retryable errors are key-level (network/timeout/5xx/429/401/403, D4):
      // they demote the key. Request-level errors (400/422 etc.) are not the
      // key's fault — throw without recording so client 400s never cool a key.
      if (!isRetryableUpstreamError(e)) break;
      pool.recordFailure(decision.keyId);
    }
  }
  throw lastError;
}

export async function forwardToUpstream(opts: {
  provider: Provider;
  endpoint: GatewayEndpoint;
  body: Record<string, unknown>;
  key: string;
  timeoutMs?: number;
  accept?: string;
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  // Client signal composition: the fetch must observe whichever of the timeout
  // or the client signal fires first. AbortSignal.any when the runtime has it
  // (probed above); otherwise a {once:true} listener forwards the client abort
  // onto the timeout controller and is removed in finally.
  let wireSignal: AbortSignal = controller.signal;
  let onClientAbort: (() => void) | undefined;
  if (opts.signal) {
    if (HAS_ABORT_SIGNAL_ANY) {
      wireSignal = AbortSignal.any([controller.signal, opts.signal]);
    } else {
      onClientAbort = () => controller.abort(opts.signal?.reason);
      if (opts.signal.aborted) onClientAbort();
      else opts.signal.addEventListener("abort", onClientAbort, { once: true });
    }
  }
  try {
    const headers: Record<string, string> = opts.provider === "anthropic"
      ? { "x-api-key": opts.key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
      : { "authorization": `Bearer ${opts.key}`, "content-type": "application/json" };
    if (opts.accept) headers.accept = opts.accept;
    log(`${opts.provider} POST ${opts.endpoint} key=${maskKey(opts.key)}`);
    const res = await fetch(resolveUpstreamUrl({ provider: opts.provider, endpoint: opts.endpoint, baseUrl: opts.baseUrl }), {
      method: "POST", headers, body: JSON.stringify(opts.body), signal: wireSignal,
    });
    if (!res.ok) {
      error(`${opts.provider} ${opts.endpoint} upstream status ${res.status} key=${maskKey(opts.key)}`);
      throw new UpstreamError(res.status, await res.json().catch(() => ({})));
    }
    return res;
  } catch (e) {
    if (!(e instanceof UpstreamError)) {
      warn(`${opts.provider} ${opts.endpoint} upstream failure key=${maskKey(opts.key)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (onClientAbort) opts.signal?.removeEventListener("abort", onClientAbort);
  }
}
