import type { AppConfig } from "./loader";
import { CONFIG_TEMPLATE } from "./template";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function checkTimeout(node: unknown, path: string, errs: string[]): void {
  if (typeof node === "number") {
    if (!Number.isFinite(node) || node <= 0)
      errs.push(`timeout.${path} must be a positive number`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node))
      checkTimeout(v, path ? `${path}.${k}` : k, errs);
  } else {
    errs.push(`timeout.${path} must be a positive number`);
  }
}

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
  if (cfg.timeout) {
    checkTimeout(cfg.timeout, "", errs);
    const br = cfg.timeout.non_stream?.by_request;
    if (typeof br?.min === "number" && typeof br?.max === "number" && br.min > br.max)
      errs.push(`timeout.non_stream.by_request.min must be <= max (${br.min} > ${br.max})`);
  }
  return errs;
}
export { CONFIG_TEMPLATE };
