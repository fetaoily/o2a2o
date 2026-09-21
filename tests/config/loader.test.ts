import { test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/config/loader";
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
