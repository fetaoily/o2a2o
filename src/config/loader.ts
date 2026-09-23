import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export class ConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = "ConfigError"; }
}

export interface ApiKeyConfig { key: string; priority: number; weight?: number }
// base_url (optional, per model): the FULL upstream prefix including its
// version segment (SDK convention), e.g. Zhipu's "https://open.bigmodel.cn/api/paas/v4".
// When absent the provider's env override / default origin serves the request.
// upstream_format (optional, per model, openai only): forces the upstream wire
// protocol to "chat". Set it on OpenAI-compatible upstreams that serve only
// /v1/chat/completions (e.g. Zhipu's /api/paas/v4, whose /v1/responses 404s):
// inbound /v1/responses requests then convert through the IR to the chat
// protocol instead of passing through.
export interface ModelConfig {
  name: string;
  provider: "openai" | "anthropic";
  api_keys: ApiKeyConfig[];
  base_url?: string;
  upstream_format?: "chat";
}
export interface ServerConfig { port: number; host: string; log_level: string; auth_token?: string }
export interface TimeoutConfig {
  non_stream: {
    default: number;
    by_model: Record<string, number>;
    by_request: { ms_per_token: number; min: number; max: number };
  };
  stream: {
    first_packet: number;
    idle: number;
    idle_check_interval: number;
    idle_grace_period: number;
    total_max: number;
  };
}
export interface FailoverConfig {
  max_retries: number;
  failure_threshold: number;
  cooldown_ms: number;
  latency_window: number;
  recovery_successes: number;
}
export interface UpdateConfig {
  enabled: boolean;
  repo: string;
  check_on_start: boolean;
  allow_prerelease: boolean;
}
export interface AppConfig {
  server: ServerConfig;
  models: ModelConfig[];
  aliases: Record<string, string>;
  api_keys: { openai?: string; anthropic?: string };
  timeout?: TimeoutConfig;
  failover?: FailoverConfig;
  update?: UpdateConfig;
}

const ENV_REF = /^\$\{(.+)\}$/;

function resolveEnv(value: unknown, path: string): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(ENV_REF);
  if (!m) return value;
  const v = process.env[m[1]];
  if (v === undefined) throw new ConfigError(`undefined environment variable at ${path}: \${${m[1]}}`);
  return v;
}

function walk(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, `${path}.${k}`);
    return out;
  }
  return resolveEnv(node, path);
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new ConfigError(`config file not found: ${path}`);
    throw new ConfigError(`cannot read config file: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  let doc: unknown;
  try { doc = parse(text); }
  catch (e) { throw new ConfigError(`invalid yaml in ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc))
    throw new ConfigError("config file is empty or not a mapping");
  const cfg = walk(doc, "root") as AppConfig;
  cfg.server ??= { port: 8080, host: "127.0.0.1", log_level: "info" };
  cfg.models ??= [];
  cfg.aliases ??= {};
  cfg.api_keys ??= {};
  for (const [i, m] of cfg.models.entries()) {
    validateUpstreamFormat(m, `models[${i}].upstream_format`);
    const base = validateBaseUrl(m.base_url, `models[${i}].base_url`);
    if (base !== undefined) m.base_url = base;
  }
  return cfg;
}

// model.upstream_format validation: the only supported override is "chat", and
// only on an openai-provider model (on anthropic it would change the auth
// header semantics). Any other value — including "responses", whose outbound
// request encoder does not exist yet — is a config error with the field path.
function validateUpstreamFormat(m: ModelConfig, path: string): void {
  const v: unknown = m.upstream_format; // raw YAML content, untrusted
  if (v === undefined) return;
  if (m.provider !== "openai")
    throw new ConfigError(`${path} is only supported on provider "openai" models`);
  if (v !== "chat")
    throw new ConfigError(`${path} must be "chat" when set (got ${JSON.stringify(v)})`);
}

// model.base_url validation (live-test hardening Task 2): must be a non-empty
// http(s) URL without query string or hash. Normalized in place: trailing
// slashes stripped, so appending the method path cannot double up.
function validateBaseUrl(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "")
    throw new ConfigError(`${path} must be a non-empty http(s) URL`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ConfigError(`${path} is not a valid URL: ${value}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ConfigError(`${path} must be an http(s) URL: ${value}`);
  if (url.search || url.hash)
    throw new ConfigError(`${path} must not contain a query string or hash: ${value}`);
  return value.replace(/\/+$/, "");
}

const TIMEOUT_DEFAULTS: TimeoutConfig = {
  non_stream: {
    default: 60000,
    by_model: {},
    by_request: { ms_per_token: 100, min: 30000, max: 300000 },
  },
  stream: {
    first_packet: 30000,
    idle: 60000,
    idle_check_interval: 10000,
    idle_grace_period: 5000,
    total_max: 600000,
  },
};

export function resolveTimeoutConfig(cfg: AppConfig): TimeoutConfig {
  const t: Partial<TimeoutConfig> = cfg.timeout ?? {};
  const ns: Partial<TimeoutConfig["non_stream"]> = t.non_stream ?? {};
  const st: Partial<TimeoutConfig["stream"]> = t.stream ?? {};
  return {
    non_stream: {
      default: ns.default ?? TIMEOUT_DEFAULTS.non_stream.default,
      by_model: ns.by_model ?? {},
      by_request: { ...TIMEOUT_DEFAULTS.non_stream.by_request, ...ns.by_request },
    },
    stream: { ...TIMEOUT_DEFAULTS.stream, ...st },
  };
}

const FAILOVER_DEFAULTS: FailoverConfig = {
  max_retries: 3,
  failure_threshold: 3,
  cooldown_ms: 300000,
  latency_window: 10,
  recovery_successes: 3,
};

export function resolveFailoverConfig(cfg: AppConfig): FailoverConfig {
  return { ...FAILOVER_DEFAULTS, ...(cfg.failover ?? {}) };
}

const UPDATE_DEFAULTS: UpdateConfig = {
  enabled: true,
  repo: "fetaoily/o2a2o",
  check_on_start: true,
  allow_prerelease: true,
};

export function resolveUpdateConfig(cfg: AppConfig): UpdateConfig {
  return { ...UPDATE_DEFAULTS, ...(cfg.update ?? {}) };
}
