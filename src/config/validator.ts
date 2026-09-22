import type { AppConfig } from "./loader";
import { CONFIG_TEMPLATE } from "./template";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

// Counting-class failover fields must be whole numbers; duration fields
// (failover.cooldown_ms and every timeout.* leaf) stay float-allowed. The
// timeout section has no counting-class fields, so it uses the default
// float-allowed check.
const FAILOVER_INT_FIELDS = new Set(["max_retries", "failure_threshold", "latency_window", "recovery_successes"]);

function checkPositive(
  section: string,
  node: unknown,
  path: string,
  errs: string[],
  intFields: ReadonlySet<string> = new Set(),
): void {
  if (typeof node === "number") {
    if (!Number.isFinite(node) || node <= 0)
      errs.push(`${section}.${path} must be a positive number`);
    else if (intFields.has(path) && !Number.isInteger(node))
      errs.push(`${section}.${path} must be a positive integer`);
    return;
  }
  if (!Array.isArray(node) && node && typeof node === "object") {
    for (const [k, v] of Object.entries(node))
      checkPositive(section, v, path ? `${path}.${k}` : k, errs, intFields);
  } else {
    errs.push(`${section}.${path} must be a positive number`);
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
    checkPositive("timeout", cfg.timeout, "", errs);
    const br = cfg.timeout.non_stream?.by_request;
    if (typeof br?.min === "number" && typeof br?.max === "number" && br.min > br.max)
      errs.push(`timeout.non_stream.by_request.min must be <= max (${br.min} > ${br.max})`);
  }
  if (cfg.failover) {
    checkPositive("failover", cfg.failover, "", errs, FAILOVER_INT_FIELDS);
  }
  return errs;
}
export { CONFIG_TEMPLATE };
