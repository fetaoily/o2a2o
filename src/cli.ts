// CLI entry: hand-rolled argv scanner plus the serve / config / convert /
// version / help command implementations. No argument-parsing dependency.
import { readFile } from "node:fs/promises";
import { loadConfig, type AppConfig } from "./config/loader";
import { validateConfig, CONFIG_TEMPLATE } from "./config/validator";
import { startGateway } from "./server";
import { maskKey, setLogLevel } from "./utils/logger";
import { detectFormat, type InputFormat } from "./core/format-detector";
import type { IRRequest } from "./types/ir";
import { chatToIr, irToChat, type ConvResult } from "./converters/chat";
import { responsesToIr, irToResponses } from "./converters/responses";
import { anthropicToIr, irToAnthropic } from "./converters/anthropic";

const VERSION = "0.1.0";
const DEFAULT_CONFIG_PATH = "./o2a2o.yaml";

export type CliCommand =
  | { cmd: "serve"; configPath: string; port?: number }
  | { cmd: "config"; sub: "init" | "validate" | "routes"; configPath?: string }
  | { cmd: "convert"; inputPath: string; to?: InputFormat }
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
  if (first === "convert") {
    let inputPath: string | undefined;
    let to: InputFormat | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--input") {
        const v = argv[++i];
        if (v !== undefined) inputPath = v;
      } else if (argv[i] === "--to") {
        const v = argv[++i];
        if (v !== undefined) to = v as InputFormat;
      }
    }
    return { cmd: "convert", inputPath: inputPath ?? "", to };
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
  o2a2o convert --input <path> [--to <fmt>]    convert a request body between protocols
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

// Offline protocol-conversion debug: read a request body from a file, detect
// its format, convert to the target format (default: the other side of the
// pair) and print it. Request direction only; responses are not converted.
const CONVERT_COUNTERPART: Record<InputFormat, InputFormat> = {
  openai_chat: "anthropic",
  openai_responses: "anthropic",
  anthropic: "openai_chat",
};
const CONVERT_TO_IR: Record<InputFormat, (body: unknown) => ConvResult> = {
  openai_chat: chatToIr, openai_responses: responsesToIr, anthropic: anthropicToIr,
};
const CONVERT_FROM_IR: Record<InputFormat, (ir: IRRequest) => Record<string, unknown>> = {
  openai_chat: irToChat, openai_responses: irToResponses, anthropic: irToAnthropic,
};

async function convertCommand(parsed: Extract<CliCommand, { cmd: "convert" }>): Promise<number> {
  if (!parsed.inputPath) {
    console.error("convert requires --input <path>");
    return 1;
  }
  if (parsed.to !== undefined && !Object.hasOwn(CONVERT_COUNTERPART, parsed.to)) {
    console.error(`invalid --to value: ${parsed.to} (expected openai_chat, openai_responses or anthropic)`);
    return 1;
  }
  let text: string;
  try { text = await readFile(parsed.inputPath, "utf8"); }
  catch (e) {
    console.error(`cannot read input file: ${parsed.inputPath} (${e instanceof Error ? e.message : String(e)})`);
    return 1;
  }
  let body: unknown;
  try { body = JSON.parse(text); }
  catch {
    console.error("input is not valid JSON");
    return 1;
  }
  try {
    const src = detectFormat("<stdin>", body);
    const dst: InputFormat = parsed.to ?? CONVERT_COUNTERPART[src];
    const { ir } = CONVERT_TO_IR[src](body);
    console.log(JSON.stringify(CONVERT_FROM_IR[dst](ir), null, 2));
    return 0;
  }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
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
    case "convert": return convertCommand(parsed);
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      printUsage();
      return 0;
  }
}
