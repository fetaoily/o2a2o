// GET /v1/models body in either ecosystem format, the GET /health/keys body
// (M3), the /admin/keys/:keyId/reset pool resolver, and the gateway bearer
// auth gate (TECH-DESIGN §15: /v1/models speaks openai by default and
// anthropic when the request carries an anthropic-style credential header).
import type { AppConfig } from "../config/loader";
import type { ApiKeyPool } from "./api-key-pool";
import { KeyPoolRegistry, NoKeysConfigError } from "./forwarder";
import { warn } from "../utils/logger";

export function modelsBody(cfg: AppConfig, anthropicShape: boolean): Record<string, unknown> {
  if (!anthropicShape) return {
    object: "list",
    data: cfg.models.map(m => ({ id: m.name, object: "model", created: 0, owned_by: m.provider })),
  };
  const ids = cfg.models.map(m => m.name);
  return {
    data: cfg.models.map(m => ({ id: m.name, type: "model", display_name: m.name,
      created_at: new Date(0).toISOString(), max_input_tokens: null, max_tokens: null })),
    first_id: ids[0] ?? null, has_more: false, last_id: ids[ids.length - 1] ?? null,
  };
}

export function checkAuth(cfg: AppConfig, headers: Record<string, string | undefined>): boolean {
  if (!cfg.server.auth_token) return true;
  return headers.authorization === `Bearer ${cfg.server.auth_token}`;
}

// GET /health/keys body: `{ timestamp, models: { [name]: { [maskedKeyId]:
// { status, consecutiveFailures, totalFailures, avgLatency, cooldownRemaining } } } }`.
// Plaintext keys never appear — ids are the pool's masked keyIds. Each pool is
// swept with maybeRecover() first so expired cooldowns report as degraded, and
// cooldownRemaining = max(0, cooldownUntil - now). A model with neither model
// keys nor a provider-wide key has no pool (poolFor throws NoKeysConfigError)
// and appears as {} so that misconfiguration stays visible in the inventory;
// any other pool failure (duplicate key id, unexpected error) propagates and
// fails the health endpoint rather than rendering as an empty inventory.
export function healthKeysBody(
  cfg: AppConfig,
  deps: { registry?: KeyPoolRegistry } = {},
): Record<string, unknown> {
  const registry = deps.registry ?? KeyPoolRegistry.from(cfg);
  const models: Record<string, Record<string, Record<string, unknown>>> = {};
  const now = Date.now();
  for (const model of cfg.models) {
    let pool: ApiKeyPool;
    try { pool = registry.poolFor(model); }
    catch (e) {
      if (e instanceof NoKeysConfigError) {
        // keyless + globalless: no pool exists; keep the model visible as {}
        warn(`no key pool for model ${model.name}: no api key configured`);
        models[model.name] = {};
        continue;
      }
      throw e; // broken config or unexpected failure: fail loudly, no {}
    }
    pool.maybeRecover();
    const snap = pool.snapshot();
    const states: Record<string, Record<string, unknown>> = {};
    for (const keyId of snap.keys) {
      const s = snap[keyId];
      states[keyId] = {
        status: s.status,
        consecutiveFailures: s.consecutiveFailures,
        totalFailures: s.totalFailures,
        avgLatency: s.avgLatency,
        cooldownRemaining: Math.max(0, s.cooldownUntil - now),
      };
    }
    models[model.name] = states;
  }
  return { timestamp: now, models };
}

// /admin/keys/:keyId/reset resolver: finds the one model pool whose keyId
// space contains the masked id (configuration order). Returns undefined when
// no configured pool owns the id — the endpoint renders 404. A keyless model
// has no pool and can never match.
export function resolveKeyId(cfg: AppConfig, keyId: string): ApiKeyPool | undefined {
  const registry = KeyPoolRegistry.from(cfg);
  for (const model of cfg.models) {
    let pool: ApiKeyPool;
    try { pool = registry.poolFor(model); }
    catch { continue; } // keyless + globalless: no pool to search
    if (pool.snapshot().keys.includes(keyId)) return pool;
  }
  return undefined;
}
