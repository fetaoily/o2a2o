import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolveKey, forwardToUpstream, UpstreamError } from "../../src/core/forwarder";
import type { AppConfig } from "../../src/config/loader";

const cfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [
    { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-cfg", priority: 1 }] },
    { name: "claude", provider: "anthropic", api_keys: [{ key: "sk-ant-cfg", priority: 2 }, { key: "sk-ant-cfg2", priority: 1 }] },
  ],
  aliases: {}, api_keys: { openai: "sk-global" },
};

test("key priority: header > body > lowest-priority config > global", () => {
  expect(resolveKey(cfg, "openai", { "x-o2a2o-openai-key": "sk-hdr" }, {}).key).toBe("sk-hdr");
  expect(resolveKey(cfg, "openai", {}, { o2a2o_keys: { openai: "sk-body" } }).key).toBe("sk-body");
  expect(resolveKey(cfg, "anthropic", {}, {}).key).toBe("sk-ant-cfg2");   // priority 1 wins
  expect(resolveKey(cfg, "openai", {}, {}).key).toBe("sk-cfg");
});
test("o2a2o_keys stripped from returned body", () => {
  const { body } = resolveKey(cfg, "openai", {}, { o2a2o_keys: { openai: "k" }, model: "gpt-4o" });
  expect(body).toEqual({ model: "gpt-4o" });
});
test("no key anywhere throws", () => {
  expect(() => resolveKey({ ...cfg, models: [], api_keys: {} }, "anthropic", {}, { model: "nope" } as any)).toThrow(/no api key/i);
});

beforeEach(() => { mock.restore(); });
// global.fetch is assigned directly below; mock.restore() does not undo direct
// assignments, so restore it explicitly to keep the leak out of later test files.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
test("forwardToUpstream sends provider-correct headers; non-2xx throws UpstreamError", async () => {
  const fetchMock = mock(async (url: any, init: any) => {
    if (String(url).includes("anthropic")) {
      expect(init.headers["x-api-key"]).toBe("sk-ant");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "rate limited", type: "requests" } }), { status: 429 });
  });
  global.fetch = fetchMock as any;
  process.env.O2A2O_UPSTREAM_ANTHROPIC = "http://anthropic-mock:9";
  const ok = await forwardToUpstream({ provider: "anthropic", endpoint: "/v1/messages", body: {} as any, key: "sk-ant" });
  expect(ok.status).toBe(200);
  try {
    await forwardToUpstream({ provider: "openai", endpoint: "/v1/chat/completions", body: {} as any, key: "sk-x" });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(429);
  }
  delete process.env.O2A2O_UPSTREAM_ANTHROPIC;
});
