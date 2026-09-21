import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export class ConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = "ConfigError"; }
}

export interface ApiKeyConfig { key: string; priority: number; weight?: number }
export interface ModelConfig { name: string; provider: "openai" | "anthropic"; api_keys: ApiKeyConfig[] }
export interface ServerConfig { port: number; host: string; log_level: string; auth_token?: string }
export interface AppConfig {
  server: ServerConfig;
  models: ModelConfig[];
  aliases: Record<string, string>;
  api_keys: { openai?: string; anthropic?: string };
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
  catch { throw new ConfigError(`config file not found: ${path}`); }
  const raw = walk(parse(text), "root");
  const cfg = raw as AppConfig;
  cfg.server ??= { port: 8080, host: "127.0.0.1", log_level: "info" };
  cfg.models ??= [];
  cfg.aliases ??= {};
  cfg.api_keys ??= {};
  return cfg;
}
