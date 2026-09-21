import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export class ConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = "ConfigError"; }
}

export interface ApiKeyConfig { key: string; priority: number; weight?: number }
export interface ModelConfig { name: string; provider: "openai" | "anthropic"; api_keys: ApiKeyConfig[] }
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
export interface AppConfig {
  server: ServerConfig;
  models: ModelConfig[];
  aliases: Record<string, string>;
  api_keys: { openai?: string; anthropic?: string };
  timeout?: TimeoutConfig;
  failover?: FailoverConfig;
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
  return cfg;
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
