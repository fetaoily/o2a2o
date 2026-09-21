import { test, expect } from "bun:test";
import { modelsBody, checkAuth } from "../../src/core/models-endpoint";
import type { AppConfig } from "../../src/config/loader";

const cfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "k", priority: 1 }] }],
  aliases: {}, api_keys: {},
};

test("S10 openai shape by default", () => {
  const b = modelsBody(cfg, false) as any;
  expect(b.object).toBe("list");
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", object: "model", owned_by: "openai" });
});
test("S10 anthropic shape on demand", () => {
  const b = modelsBody(cfg, true) as any;
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", type: "model", display_name: "gpt-4o" });
  expect(b.has_more).toBe(false);
});
test("auth: token configured -> Bearer required", () => {
  const c = { ...cfg, server: { ...cfg.server, auth_token: "t0ken" } };
  expect(checkAuth(c, { authorization: "Bearer t0ken" })).toBe(true);
  expect(checkAuth(c, {})).toBe(false);
  expect(checkAuth(c, { authorization: "Bearer wrong" })).toBe(false);
});
test("auth: no token configured -> always pass", () =>
  expect(checkAuth(cfg, {})).toBe(true));
