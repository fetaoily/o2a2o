import { test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, ConfigError, resolveTimeoutConfig } from "../../src/config/loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "o2a2o-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const YAML = `
server: { port: 8080, host: "127.0.0.1", log_level: "info" }
models:
  - name: "gpt-4o"
    provider: "openai"
    api_keys:
      - { key: "sk-openai-1", priority: 1 }
  - name: "claude-sonnet-4-5"
    provider: "anthropic"
    api_keys:
      - { key: "\${ANTHROPIC_KEY_1}", priority: 1 }
aliases: { sonnet: "claude-sonnet-4-5" }
api_keys: { openai: "\${OPENAI_API_KEY}" }
`;

test("resolves ${VAR} from environment", async () => {
  process.env.ANTHROPIC_KEY_1 = "sk-ant-xyz";
  process.env.OPENAI_API_KEY = "sk-fallback";
  const p = join(dir, "o2a2o.yaml");
  writeFileSync(p, YAML);
  const cfg = await loadConfig(p);
  expect(cfg.models[1].api_keys[0].key).toBe("sk-ant-xyz");
  expect(cfg.api_keys.openai).toBe("sk-fallback");
  expect(cfg.server.port).toBe(8080);
});

test("undefined env var fails with field path", async () => {
  delete process.env.ANTHROPIC_KEY_1;
  process.env.OPENAI_API_KEY = "x";
  const p = join(dir, "o2a2o.yaml");
  writeFileSync(p, YAML);
  await expect(loadConfig(p)).rejects.toThrow(/models\[1\].api_keys\[0\].key/);
});

test("missing file fails clearly", async () => {
  await expect(loadConfig(join(dir, "nope.yaml"))).rejects.toThrow(/config file not found/i);
});

test("timeout section loads with defaults when absent", async () => {
  const p = join(dir, "t1.yaml");
  writeFileSync(p, 'server: { port: 1, host: "127.0.0.1" }\nmodels: [{ name: "m", provider: "openai", api_keys: [{ key: "k", priority: 1 }] }]\n');
  const cfg = await loadConfig(p);
  const t = resolveTimeoutConfig(cfg);
  expect(t.non_stream.default).toBe(60000);
  expect(t.stream.first_packet).toBe(30000);
  expect(t.stream.total_max).toBe(600000);
});

test("timeout section loads explicit values", async () => {
  const p = join(dir, "t2.yaml");
  writeFileSync(p, 'timeout:\n  stream:\n    first_packet: 5000\n');
  const cfg = await loadConfig(p);
  expect(resolveTimeoutConfig(cfg).stream.first_packet).toBe(5000);
});

test("empty yaml file -> ConfigError, not TypeError", async () => {
  const p = join(dir, "t3.yaml");
  writeFileSync(p, "");
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("yaml syntax error -> ConfigError wrapping cause", async () => {
  const p = join(dir, "t4.yaml");
  writeFileSync(p, "models: [\n  broken");
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("unreadable file (bad path type) -> clear error, not 'not found'", async () => {
  // directory instead of file exercises the non-ENOENT read failure path
  await expect(loadConfig(dir)).rejects.toThrow(/cannot read config file/i);
});
