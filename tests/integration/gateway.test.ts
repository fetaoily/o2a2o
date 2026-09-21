import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "../../src/server";
import type { AppConfig } from "../../src/config/loader";

let anthropicUp: ReturnType<typeof Bun.serve>; let openaiUp: ReturnType<typeof Bun.serve>;
let gw: ReturnType<typeof Bun.serve>; let streamGw: ReturnType<typeof Bun.serve>;
let slowUp: Bun.TCPSocketListener<{ responded?: boolean }>;

// File-level so the auth-bearing gateway variant (S11) can derive from it.
const cfgBase: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [
    { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-oai", priority: 1 }] },
    { name: "claude-sonnet-4-5", provider: "anthropic", api_keys: [{ key: "sk-ant", priority: 1 }] },
  ],
  aliases: { sonnet: "claude-sonnet-4-5", gpt: "gpt-4o" }, api_keys: {},
};

// Streaming gateway variant: only the first-packet budget is shortened; the
// other stream budgets match the resolved defaults so nothing else fires.
const streamCfg: AppConfig = {
  ...cfgBase,
  timeout: {
    non_stream: { default: 60000, by_model: {}, by_request: { ms_per_token: 100, min: 30000, max: 300000 } },
    stream: { first_packet: 100, idle: 60000, idle_check_interval: 10000, idle_grace_period: 5000, total_max: 600000 },
  },
};

// SSE fixtures served by the mock upstreams' stream:true branches. Authored
// as exact byte strings so the passthrough test can assert byte identity.
const openaiSseFixture =
  'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n' +
  'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"stream-hello"}}]}\n\n' +
  'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";
const openaiErrFixture =
  'data: {"id":"chatcmpl-e","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n' +
  'data: {"error":{"message":"upstream boom"}}\n\n';
const anthropicSseFixture =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream-hello"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const responsesSseFixture =
  'data: {"type":"response.created","response":{"id":"resp_s","object":"response","created_at":1,"model":"gpt-4o","status":"in_progress"}}\n\n' +
  'data: {"type":"response.output_text.delta","item_id":"msg_s","output_index":0,"content_index":0,"delta":"stream-hello"}\n\n' +
  'data: {"type":"response.completed","response":{"id":"resp_s","object":"response","created_at":1,"model":"gpt-4o","status":"completed","output":[{"id":"msg_s","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"stream-hello","annotations":[]}]}],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n';

beforeAll(() => {
  anthropicUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      anthropicSeen = body;
      if (body.stream === true)
        return new Response(anthropicSseFixture, { headers: { "content-type": "text/event-stream" } });
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
      if (body.stream === true) {
        if (new URL(req.url).pathname === "/v1/responses")
          return new Response(responsesSseFixture, { headers: { "content-type": "text/event-stream" } });
        const content = body.messages?.[0]?.content;
        if (content === "err") return new Response(openaiErrFixture, { headers: { "content-type": "text/event-stream" } });
        if (content === "heartbeat") return new Response(": heartbeat\n\n", { headers: { "content-type": "text/event-stream" } });
        return new Response(openaiSseFixture, { headers: { "content-type": "text/event-stream" } });
      }
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
  streamGw = startGateway(streamCfg);
  // Raw-socket upstream for the first-packet test: writes SSE headers
  // immediately but holds the first body byte for 500ms. Bun.serve only
  // flushes stream-response headers on the first body byte, which would
  // defeat a first_packet budget shorter than the delay.
  slowUp = Bun.listen<{ responded?: boolean }>({
    hostname: "127.0.0.1", port: 0,
    data: {},
    socket: {
      data(socket) {
        if (socket.data.responded) return;
        socket.data.responded = true;
        socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n");
        setTimeout(() => {
          const frame = `${openaiSseFixture.length.toString(16)}\r\n${openaiSseFixture}\r\n0\r\n\r\n`;
          try { socket.write(frame); socket.end(); } catch { /* client gone */ }
        }, 500);
      },
      error() {},
    },
  });
});
afterAll(() => { gw.stop(true); streamGw.stop(true); anthropicUp.stop(true); openaiUp.stop(true); slowUp.stop(true); });

let anthropicSeen: any; let openaiSeen: any;
const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gw.port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
const postStream = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${streamGw.port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });

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

test("S4: openai_chat stream client -> anthropic model streams chat chunks", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(anthropicSeen.stream).toBe(true);                    // upstream receives the SSE request
  expect(text).toContain('"role":"assistant"');
  expect(text).toContain('"content":"stream-hello"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("S5: openai_responses stream client -> anthropic model", async () => {
  const res = await post("/v1/responses", { model: "claude-sonnet-4-5", input: "hi", stream: true });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(text).toContain('"type":"response.output_text.delta"');
  expect(text).toContain("stream-hello");
  expect(text).toContain('"type":"response.completed"');
});

test("S6: anthropic stream client -> openai model emits message_start/message_stop", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(openaiSeen.stream).toBe(true);
  expect(text).toContain("event: message_start");
  expect(text).toContain('"stop_reason":"end_turn"');         // anthropic wire value for a normal stop
  expect(text).toContain("event: message_stop");
});

test("passthrough stream: openai_chat -> openai model pipes bytes verbatim", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true });
  const text = await res.text();
  expect(text).toBe(openaiSseFixture);
});

test("passthrough stream: anthropic -> anthropic model pipes bytes verbatim", async () => {
  const res = await post("/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 99, messages: [{ role: "user", content: "hi" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(text).toBe(anthropicSseFixture);                       // byte-identical
  expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
});

test("passthrough stream: openai_responses -> openai model pipes bytes verbatim", async () => {
  const res = await post("/v1/responses", { model: "gpt-4o", input: "hi", stream: true });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(text).toBe(responsesSseFixture);                       // byte-identical
  const lastLine = text.trimEnd().split("\n").at(-1) ?? "";
  expect(lastLine.startsWith('data: {"type":"response.completed"')).toBe(true);
});

test("stream truthiness: stream:'true' selects the streaming path", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: "true" });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toContain("stream-hello");
});

test("slow first frame vs short first_packet budget -> error frame then close", async () => {
  // The slow raw-socket upstream stands in for the openai provider for this
  // request only; the env var is restored so later tests hit openaiUp.
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${slowUp.port}`;
  try {
    const res = await postStream("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "slow" }], stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("stream timeout: first_packet");
    expect(text).toContain('"error"');
    expect(text).not.toContain("stream-hello");                 // the late upstream frame never surfaces
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(false); // no finish frames after an error
  } finally {
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("heartbeat-only upstream body closes the stream gracefully", async () => {
  // anthropic client -> openai upstream returning only a comment frame:
  // convertStream sees no events and must still emit the termination frames.
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "heartbeat" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_stop");              // proper termination frames, no crash
});

test("mid-stream upstream error surfaces a target-format error frame, no finish frames", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "err" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  const text = await res.text();
  expect(text).toContain("event: error");
  expect(text).toContain("upstream boom");
  expect(text).not.toContain("stream-hello");
  expect(text).not.toContain("event: message_delta");
  expect(text).not.toContain("event: message_stop");
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
