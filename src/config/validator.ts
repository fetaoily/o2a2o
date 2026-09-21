import type { AppConfig } from "./loader";
import { CONFIG_TEMPLATE } from "./template";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function validateConfig(cfg: AppConfig): string[] {
  const errs: string[] = [];
  if (!cfg.models?.length) errs.push("models must not be empty");
  const names = new Set<string>();
  for (const m of cfg.models ?? []) {
    if (names.has(m.name)) errs.push(`duplicate model name: ${m.name}`);
    names.add(m.name);
    if (m.provider !== "openai" && m.provider !== "anthropic")
      errs.push(`invalid provider for ${m.name}: ${m.provider} (expected "openai" | "anthropic")`);
  }
  for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
    if (!names.has(target)) errs.push(`alias '${alias}' resolves to unknown model: ${target}`);
  }
  if (cfg.server && !LOOPBACK.has(cfg.server.host) && !cfg.server.auth_token)
    errs.push("server.auth_token is required when binding a non-loopback host");
  return errs;
}
export { CONFIG_TEMPLATE };
