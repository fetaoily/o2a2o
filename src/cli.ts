// CLI entry: hand-rolled argv scanner plus the serve / config / version /
// help command implementations. No argument-parsing dependency.
import { loadConfig, type AppConfig } from "./config/loader";
import { validateConfig, CONFIG_TEMPLATE } from "./config/validator";
import { startGateway } from "./server";
import { maskKey, setLogLevel } from "./utils/logger";

const VERSION = "0.1.0";
const DEFAULT_CONFIG_PATH = "./o2a2o.yaml";

export type CliCommand =
  | { cmd: "serve"; configPath: string; port?: number }
  | { cmd: "config"; sub: "init" | "validate" | "routes"; configPath?: string }
  | { cmd: "version" }
  | { cmd: "help" };

export function parsePort(v: string): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseArgv(argv: string[]): CliCommand {
  const first = argv[0] ?? "";
  if (first === "version") return { cmd: "version" };
  if (first === "config") {
    const sub = argv[1];
    if (sub === "init") return { cmd: "config", sub: "init", configPath: undefined };
    if (sub === "validate") return { cmd: "config", sub: "validate", configPath: argv[2] };
    if (sub === "routes") return { cmd: "config", sub: "routes", configPath: undefined };
    return { cmd: "help" };
  }
  if (first === "serve") {
    let configPath = DEFAULT_CONFIG_PATH;
    let port: number | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--config") {
        const v = argv[++i];
        if (v !== undefined) configPath = v;
      } else if (argv[i] === "--port") {
        const v = argv[++i];
        if (v !== undefined) port = parsePort(v);
      }
    }
    return { cmd: "serve", configPath, port };
  }
  return { cmd: "help" };
}

function printUsage(): void {
  console.log(`o2a2o ${VERSION}

Usage:
  o2a2o serve [--config <path>] [--port <n>]   start the gateway (default config: ${DEFAULT_CONFIG_PATH})
  o2a2o config init                            print a starter config template to stdout
  o2a2o config validate <path>                 validate a config file
  o2a2o config routes                          list models, aliases and masked keys (config: ${DEFAULT_CONFIG_PATH})
  o2a2o version                                print the version
  o2a2o help                                   show this help`);
}

async function serveCommand(configPath: string, port?: number): Promise<number> {
  let cfg: AppConfig;
  try { cfg = await loadConfig(configPath); }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const err of errors) console.error(err);
    return 1;
  }
  setLogLevel(cfg.server.log_level);
  if (port !== undefined) cfg.server.port = port;
  startGateway(cfg);
  console.log(`http://${cfg.server.host}:${cfg.server.port}`);
  return 0;
}

async function configCommand(parsed: Extract<CliCommand, { cmd: "config" }>): Promise<number> {
  if (parsed.sub === "init") {
    console.log(CONFIG_TEMPLATE);
    return 0;
  }
  const path = parsed.configPath ?? DEFAULT_CONFIG_PATH;
  let cfg: AppConfig;
  try { cfg = await loadConfig(path); }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (parsed.sub === "validate") {
    const errors = validateConfig(cfg);
    if (errors.length > 0) {
      for (const err of errors) console.error(err);
      return 1;
    }
    console.log("ok");
    return 0;
  }
  // routes
  for (const m of cfg.models) {
    console.log(`${m.name} (${m.provider})`);
    for (const k of m.api_keys) console.log(`  pri=${k.priority} ${maskKey(k.key)}`);
  }
  for (const [alias, target] of Object.entries(cfg.aliases)) {
    console.log(`alias ${alias} -> ${target}`);
  }
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  switch (parsed.cmd) {
    case "serve": {
      for (let i = 1; i < argv.length; i++) {
        const v = argv[i] === "--port" ? argv[i + 1] : undefined;
        if (v !== undefined && parsePort(v) === undefined)
          console.error(`ignoring invalid --port value: ${v}`);
      }
      return serveCommand(parsed.configPath, parsed.port);
    }
    case "config": return configCommand(parsed);
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      printUsage();
      return 0;
  }
}
