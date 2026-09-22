// CLI entry: hand-rolled argv scanner plus the serve / config / convert /
// version / help command implementations. No argument-parsing dependency.
import { readFile } from "node:fs/promises";
import { loadConfig, resolveUpdateConfig, type AppConfig, type UpdateConfig } from "./config/loader";
import { validateConfig, CONFIG_TEMPLATE } from "./config/validator";
import { startGateway } from "./server";
import { maskKey, setLogLevel } from "./utils/logger";
import { detectFormat, type InputFormat } from "./core/format-detector";
import type { IRRequest } from "./types/ir";
import { chatToIr, irToChat, type ConvResult } from "./converters/chat";
import { responsesToIr, irToResponses } from "./converters/responses";
import { anthropicToIr, irToAnthropic } from "./converters/anthropic";
import type { ReleaseInfo } from "./update/github-releases";
import { UpdateManager, identifiesAsO2a2o, type UpdateResult } from "./update/update-manager";
import pkg from "../package.json";

// Single source of truth: package.json, inlined at bundle time so compiled
// binaries bake the right version.
export const VERSION: string = pkg.version;
const DEFAULT_CONFIG_PATH = "./o2a2o.yaml";

export type CliCommand =
  | { cmd: "serve"; configPath: string; port?: number }
  | { cmd: "config"; sub: "init" | "validate" | "routes"; configPath?: string }
  | { cmd: "convert"; inputPath: string; to?: InputFormat }
  | { cmd: "update" }
  | { cmd: "version" }
  | { cmd: "help" };

export function parsePort(v: string): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseArgv(argv: string[]): CliCommand {
  const first = argv[0] ?? "";
  if (first === "version" || first === "--version" || first === "-v") return { cmd: "version" };
  if (first === "update") return { cmd: "update" };
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
  o2a2o update                                 check GitHub Releases and self-update the binary
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
  // Fire-and-forget update check: never blocks serve, never replaces the
  // binary, every error silent (see startupUpdateCheck).
  void startupUpdateCheck(resolveUpdateConfig(cfg));
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

// Body of `o2a2o update`, factored out of runCli so tests can inject a
// stubbed manager and stay offline. `enabled` comes from the resolved update
// config; runCli owns config loading and manager construction.
// Non-interactive by design: a found release is installed without prompting.
export async function updateCommand(manager: UpdateManager, enabled: boolean): Promise<number> {
  if (!enabled) {
    console.error("update is disabled by config (update.enabled: false)");
    return 1;
  }
  let rel: ReleaseInfo | null;
  try { rel = await manager.check(); }
  catch (e) {
    console.error(`update check failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (rel === null) {
    console.log(`already up to date (${VERSION})`);
    return 0;
  }
  let result: UpdateResult;
  try { result = await manager.update(rel); }
  catch (e) {
    // update() has no no-throw contract (e.g. a cleanup rmSync can throw);
    // surface the failure instead of letting it escape as an unhandled rejection.
    console.error(`update failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (result.ok) {
    console.log(`updated to ${rel.version}`);
    return 0;
  }
  if (result.rolledBack) {
    console.error("update failed, rolled back");
    return 1;
  }
  // Refused without ever touching the running binary; surface the reason. The
  // manager's structural refusal is a missing checksums asset; anything else
  // failed verification before the replace, with details already logged.
  const reason = rel.sha256Url === undefined
    ? "release has no checksums asset; refusing unverified install"
    : "new binary failed verification; current binary kept";
  console.error(`update refused: ${reason}`);
  return 1;
}

// Body of the `update` CLI case with its environment seams injected (identity
// probe, config loader, manager) so the full wiring — identity gate, config
// fallback, release check — is testable offline. runCli passes the real seams.
export async function updateFromEnv(deps: {
  configPath: string;
  binaryPath: string;
  identityFn?: (binaryPath: string) => boolean;
  loadConfigFn?: (path: string) => Promise<AppConfig>;
  manager?: UpdateManager;
}): Promise<number> {
  // 1. identity gate: only let a binary that identifies as o2a2o self-update.
  //    IDENTITY only, never a version comparison — an older o2a2o binary is a
  //    legitimate update source. Without this, `bun run src/index.ts update`
  //    would probe (and on success overwrite) the bun runtime executable.
  const identifies = deps.identityFn ?? identifiesAsO2a2o;
  if (!identifies(deps.binaryPath)) {
    console.error(
      `update refused: ${deps.binaryPath} does not identify as an o2a2o binary ` +
      "(running from source? install a compiled release or build with bun run build:platform)",
    );
    return 1;
  }
  // 2. config is optional for updating: a fresh install may have no config
  //    file (or an unresolvable ${ENV} reference), so fall back to the
  //    update-section defaults instead of refusing to self-update at all.
  let cfg: AppConfig;
  try { cfg = await (deps.loadConfigFn ?? loadConfig)(deps.configPath); }
  catch (e) {
    console.error(`config not loadable, using update defaults: ${e instanceof Error ? e.message : String(e)}`);
    cfg = {} as AppConfig;
  }
  const uc = resolveUpdateConfig(cfg);
  const manager = deps.manager ?? new UpdateManager({
    repo: uc.repo,
    currentVersion: VERSION,
    binaryPath: deps.binaryPath,
    allowPrerelease: uc.allow_prerelease,
  });
  return updateCommand(manager, uc.enabled);
}

// check_on_start notice: one background GitHub Releases query after serve is
// up; prints a single line when a newer release exists. Never awaits, never
// auto-replaces, swallows every error so serve is never disturbed. Returns
// the in-flight promise only so tests can await it; the serve path ignores it.
export function startupUpdateCheck(
  uc: UpdateConfig,
  deps: { manager?: UpdateManager } = {},
): Promise<void> {
  if (!uc.check_on_start) return Promise.resolve();
  const manager = deps.manager ?? new UpdateManager({
    repo: uc.repo,
    currentVersion: VERSION,
    binaryPath: process.execPath,
    allowPrerelease: uc.allow_prerelease,
  });
  return manager.check()
    .then((rel) => { if (rel) console.log(`update available: ${rel.version} (run \`o2a2o update\`)`); })
    .catch(() => { /* silent: a failed startup check must never disturb serve */ });
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
    case "update":
      return updateFromEnv({ configPath: DEFAULT_CONFIG_PATH, binaryPath: process.execPath });
    case "version":
      // Intentional version channel: brand + semver on one line. This is what
      // the updater's self-verify (`<binary> --version` must contain the new
      // version) and the update identity guard rely on.
      console.log(`o2a2o ${VERSION}`);
      return 0;
    case "help":
      printUsage();
      return 0;
  }
}
