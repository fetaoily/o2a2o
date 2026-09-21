import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "../../src/server";
import type { AppConfig } from "../../src/config/loader";

let anthropicUp: ReturnType<typeof Bun.serve>; let openaiUp: ReturnType<typeof Bun.serve>; let gw: ReturnType<typeof Bun.serve>;

// File-level so the auth-bearing gateway variant (S11) can derive from it.
const cfgBase: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [
    { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-oai", priority: 1 }] },
    { name: "claude-sonnet-4-5", provider: "anthropic", api_keys: [{ key: "sk-ant", priority: 1 }] },
  ],
  aliases: { sonnet: "claude-sonnet-4-5", gpt: "gpt-4o" }, api_keys: {},
};

beforeAll(() => {
  anthropicUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      anthropicSeen = body;
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "from-claude" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    },
  });
  openaiUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      openaiSeen = body;
      return Response.json({
        id: "chatcmpl-1", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-gpt" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  });
  process.env.O2A2O_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${anthropicUp.port}`;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${openaiUp.port}`;
  gw = startGateway(cfgBase);
});
afterAll(() => { gw.stop(true); anthropicUp.stop(true); openaiUp.stop(true); });

let anthropicSeen: any; let openaiSeen: any;
const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gw.port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });

test("S1: openai_chat client -> anthropic model, response in openai_chat shape", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], temperature: 0.5, presence_penalty: 0.4 });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("from-claude");
  expect(anthropicSeen.system).toBeUndefined();
  expect(anthropicSeen.max_tokens).toBe(4096);           // defaulted
  expect(anthropicSeen.messages[0].content).toBe("hi");  // string content
  expect(res.headers.get("x-o2a2o-dropped")).toBe("presence_penalty");
});

test("S2: openai_responses client -> anthropic model", async () => {
  const res = await post("/v1/responses", { model: "claude-sonnet-4-5", input: "hi" });
  const body = await res.json() as any;
  expect(body.object).toBe("response");
  expect(body.output[0].content[0].text).toBe("from-claude");
});

test("S3: anthropic client -> openai model", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }] },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  const body = await res.json() as any;
  expect(body.type).toBe("message");
  expect(body.content[0].text).toBe("from-gpt");
  expect(body.stop_reason).toBe("end_turn");
  expect(openaiSeen.max_tokens).toBe(99);
  expect(openaiSeen.messages[0].role).toBe("user");
});

test("S9: same-provider passthrough is transparent", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  const body = await res.json() as any;
  expect(body.choices[0].message.content).toBe("from-gpt");
  expect(openaiSeen.messages).toEqual([{ role: "user", content: "hi" }]);   // body untouched
});

test("alias resolves (sonnet)", async () => {
  const res = await post("/v1/chat/completions", { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  expect(anthropicSeen.model).toBe("claude-sonnet-4-5");
});

test("S1b: alias resolves on same-provider passthrough, canonical model name forwarded", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  expect(openaiSeen.model).toBe("gpt-4o");
});

test("F2a: anthropic-format request to openai model with x-o2a2o-output-format openai_chat returns chat.completion", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }] },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01", "x-o2a2o-output-format": "openai_chat" });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("from-gpt");
});

test("F2b: invalid x-o2a2o-output-format is a 400", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    { "x-o2a2o-output-format": "xml" });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/x-o2a2o-output-format/);
});

test("F2c: passthrough openai_chat request with output-format openai_responses converts through IR", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    { "x-o2a2o-output-format": "openai_responses" });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.object).toBe("response");
  expect(body.output[0].content[0].text).toBe("from-gpt");
});

test("F3: passthrough request with stream:true is a clean 400", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/streaming/);
});

test("F3: anthropic-format request with stream:true is a clean 400", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 10, messages: [{ role: "user", content: "hi" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/streaming/);
});

test("F3: responses-format request with stream:true is a clean 400", async () => {
  const res = await post("/v1/responses", { model: "claude-sonnet-4-5", input: "hi", stream: true });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/streaming/);
});

test("S12a: json_schema maps through to output_config.format", async () => {
  await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }],
    response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
  expect(anthropicSeen.output_config.format).toEqual({ type: "json_schema", schema: { type: "object" } });
});
test("S12b: json_object rejected with 400 openai-shaped error", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }],
    response_format: { type: "json_object" } });
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.message).toMatch(/json_object/);
});

test("unknown model -> 400 in client format", async () => {
  const res = await post("/v1/chat/completions", { model: "nope", messages: [] });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/nope/);
});

test("S10: /v1/models returns openai shape; anthropic shape with x-api-key header", async () => {
  const a = await (await fetch(`http://127.0.0.1:${gw.port}/v1/models`)).json() as any;
  expect(a.object).toBe("list");
  const b = await (await fetch(`http://127.0.0.1:${gw.port}/v1/models`, { headers: { "x-api-key": "x" } })).json() as any;
  expect(b.data[0].type).toBe("model");
});
test("S11: auth_token enforced", async () => {
  // separate gateway instance with auth_token set
  const authGw = startGateway({ ...cfgBase, server: { ...cfgBase.server, port: 0, auth_token: "sec" } });
  const noAuth = await fetch(`http://127.0.0.1:${authGw.port}/v1/models`);
  expect(noAuth.status).toBe(401);
  const withAuth = await fetch(`http://127.0.0.1:${authGw.port}/v1/models`, { headers: { authorization: "Bearer sec" } });
  expect(withAuth.status).toBe(200);
  authGw.stop(true);
});
