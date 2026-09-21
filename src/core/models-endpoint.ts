// GET /v1/models body in either ecosystem format, plus the gateway bearer
// auth gate (TECH-DESIGN §15: /v1/models speaks openai by default and
// anthropic when the request carries an anthropic-style credential header).
import type { AppConfig } from "../config/loader";

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
