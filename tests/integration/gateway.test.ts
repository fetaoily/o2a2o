import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "../../src/server";
import { KeyPoolRegistry } from "../../src/core/forwarder";
import { maskKey } from "../../src/utils/logger";
import type { AppConfig } from "../../src/config/loader";

let anthropicUp: ReturnType<typeof Bun.serve>; let openaiUp: ReturnType<typeof Bun.serve>;
let gw: ReturnType<typeof Bun.serve>; let streamGw: ReturnType<typeof Bun.serve>;
let slowUp: Bun.TCPSocketListener<{ responded?: boolean }>;
let foUp: Bun.TCPSocketListener;
let headersFailUp: ReturnType<typeof Bun.serve>;

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

// ---------------------------------------------------------------------------
// M3 Task 4 fixtures: stream first-packet failover across keys
// ---------------------------------------------------------------------------

const K_FO_SLOW = "sk-fo-slow-key-aaaaaaaa-1111";
const K_FO_FAST = "sk-fo-fast-key-bbbbbbbb-2222";
const K_FO_HDR = "sk-fo-hdr-key-cccccccc-3333";

// Fresh cfg per test: KeyPoolRegistry caches one pool set per cfg object, so
// a new object means an untouched pool. Inherits streamCfg's first_packet:100.
const foCfg = (): AppConfig => ({
  ...streamCfg,
  models: [{
    name: "gpt-4o", provider: "openai",
    api_keys: [{ key: K_FO_SLOW, priority: 1 }, { key: K_FO_FAST, priority: 2 }],
  }],
  aliases: {}, api_keys: {},
});

// Routing state for foUp / headersFailUp, reset by each failover test.
let foSlowKeys = new Set<string>();
let foSlowClosed = 0;   // torn-down slow-key sockets (half-open streams)
let foRequests = 0;     // requests the failover upstream saw
let headersFailSeen = 0;
let headersFailPrimary = 0; // headersFailSeen requests that used the primary key

const chunked = (body: string): string => `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
const SSE_HEADERS = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";

// Bun.listen's socket.data is shared across sockets on this platform (a fresh
// socket inherits the previous socket's mutated fields), so per-connection
// state lives in a WeakMap keyed by the socket object instead.
interface RawSockState {
  buf: string;
  everSlow?: boolean;
  hold?: { timer: ReturnType<typeof setTimeout>; alive: boolean };
}
const rawSocks = new WeakMap<object, RawSockState>();

// Buffered request reader: returns the next complete HTTP request (header
// block + content-length body), or null while the request is still in flight.
// Serving on complete requests only means a request split across several data
// events is never answered twice.
function takeRawRequest(socket: object): string | null {
  let st = rawSocks.get(socket);
  if (!st) {
    st = { buf: "" };
    rawSocks.set(socket, st);
  }
  const end = st.buf.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const cl = /content-length:\s*(\d+)/i.exec(st.buf.slice(0, end));
  const total = end + 4 + (cl ? Number(cl[1]) : 0);
  if (st.buf.length < total) return null;
  const request = st.buf.slice(0, total);
  st.buf = st.buf.slice(total);
  return request;
}

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
  // defeat a first_packet budget shorter than the delay. Every complete
  // request gets the hold treatment (the M3 failover loop may retry here).
  slowUp = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    data: {},
    socket: {
      data(socket, chunk) {
        const st = rawSocks.get(socket) ?? { buf: "" };
        st.buf += Buffer.from(chunk).toString("latin1");
        rawSocks.set(socket, st);
        for (;;) {
          if (takeRawRequest(socket) === null) return;
          socket.write(SSE_HEADERS);
          setTimeout(() => {
            try { socket.write(chunked(openaiSseFixture)); socket.end(); } catch { /* client gone */ }
          }, 500);
        }
      },
      error() {},
    },
  });
  // Per-key raw-socket upstream for the failover tests (Bun.serve only
  // flushes stream-response headers on the first body byte, which would
  // defeat a first_packet budget shorter than the delay): keys listed in
  // foSlowKeys get headers immediately and their first byte 500ms late;
  // every other key gets the fixture immediately. Every complete request is
  // served, and a new exchange cancels the previous hold's late write.
  foUp = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    data: {},
    socket: {
      data(socket, chunk) {
        const st = rawSocks.get(socket) ?? { buf: "" };
        st.buf += Buffer.from(chunk).toString("latin1");
        rawSocks.set(socket, st);
        for (;;) {
          const request = takeRawRequest(socket);
          if (request === null) return;
          if (st.hold) {                         // stale hold: its late write must not leak into this response
            clearTimeout(st.hold.timer);
            st.hold.alive = false;
            st.hold = undefined;
          }
          foRequests += 1;
          const auth = /authorization:\s*Bearer\s+(\S+)/i.exec(request)?.[1] ?? "";
          if (foSlowKeys.has(auth)) {
            st.everSlow = true;
            const hold: { timer: ReturnType<typeof setTimeout>; alive: boolean } = { timer: undefined as never, alive: true };
            st.hold = hold;
            socket.write(SSE_HEADERS);
            hold.timer = setTimeout(() => {
              if (!hold.alive) return;
              st.hold = undefined;
              try { socket.write(chunked(openaiSseFixture)); socket.end(); } catch { /* client gone */ }
            }, 500);
          } else {
            socket.write(SSE_HEADERS + chunked(openaiSseFixture));
            socket.end();
          }
        }
      },
      close(socket) {
        const st = rawSocks.get(socket);
        if (st?.everSlow) foSlowClosed += 1;
      },
      error() {},
    },
  });
  // Headers-phase failure upstream: the first-priority key gets a 500 before
  // any stream bytes; every other key serves the normal SSE fixture.
  // headersFailPrimary counts requests that presented the primary key, so the
  // M3 health/reset test can assert pool selection order directly.
  headersFailUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      headersFailSeen += 1;
      if (req.headers.get("authorization") === `Bearer ${K_FO_SLOW}`) {
        headersFailPrimary += 1;
        return Response.json({ error: { message: "key exploded" } }, { status: 500 });
      }
      return new Response(openaiSseFixture, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => {
  gw.stop(true); streamGw.stop(true); anthropicUp.stop(true); openaiUp.stop(true); slowUp.stop(true);
  foUp.stop(true); headersFailUp.stop(true);
});

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

// ---------------------------------------------------------------------------
// M3 Task 4: stream first-packet failover across keys
// ---------------------------------------------------------------------------

const postFo = (port: number | undefined, b: unknown, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b),
  });
const streamBody = () => ({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true });

test("M3 failover: slow first-packet key A fails over to fast key B, client sees only B's stream", async () => {
  foSlowKeys = new Set([K_FO_SLOW]); foSlowClosed = 0; foRequests = 0;
  const cfg = foCfg();
  const foGw = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${foUp.port}`;
  try {
    const res = await postFo(foGw.port, streamBody());
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toBe(openaiSseFixture);                       // B's normal stream, byte-identical
    expect(foRequests).toBe(2);                                // A's attempt + B's attempt
    for (let i = 0; i < 100 && foSlowClosed === 0; i++) await Bun.sleep(10);
    expect(foSlowClosed).toBeGreaterThanOrEqual(1);            // A's half-open socket torn down
    const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot();
    expect(snap[maskKey(K_FO_SLOW)].totalFailures).toBe(1);    // A recorded as failed
    expect(snap[maskKey(K_FO_FAST)].latencySamples).toHaveLength(1); // B's first-packet latency recorded
    expect(snap[maskKey(K_FO_FAST)].totalFailures).toBe(0);
  } finally {
    foGw.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("M3 failover exhausted: all keys slow -> first_packet error frame after max_retries attempts", async () => {
  foSlowKeys = new Set([K_FO_SLOW, K_FO_FAST]); foSlowClosed = 0; foRequests = 0;
  const cfg = foCfg();
  const foGw = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${foUp.port}`;
  try {
    const res = await postFo(foGw.port, streamBody());
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("stream timeout: first_packet");
    expect(text).toContain('"error"');
    expect(text).not.toContain("stream-hello");                 // the late frames never surface
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(false); // no finish frames after an error
    expect(foRequests).toBe(3);                                 // max_retries default bounds total attempts
    const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot();
    const failures = Object.keys(snap).filter((k) => k !== "keys")
      .reduce((sum, id) => sum + snap[id].totalFailures, 0);
    expect(failures).toBe(3);                                   // every attempt recorded a key failure
  } finally {
    foGw.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("M3 failover: headers-phase 500 on key A falls over to key B before any bytes", async () => {
  headersFailSeen = 0;
  const cfg = foCfg();
  const foGw = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${headersFailUp.port}`;
  try {
    const res = await postFo(foGw.port, streamBody());
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toBe(openaiSseFixture);                        // B served normally
    expect(headersFailSeen).toBe(2);                            // A's 500 then B's success
    const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot();
    expect(snap[maskKey(K_FO_SLOW)].totalFailures).toBe(1);
    expect(snap[maskKey(K_FO_FAST)].totalFailures).toBe(0);
  } finally {
    foGw.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("M3 failover: dynamic header key makes a single attempt with no pool interaction", async () => {
  foSlowKeys = new Set([K_FO_HDR]); foSlowClosed = 0; foRequests = 0;
  const cfg = foCfg();
  const foGw = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${foUp.port}`;
  try {
    const res = await postFo(foGw.port, streamBody(), { "x-o2a2o-openai-key": K_FO_HDR });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("stream timeout: first_packet");     // M2 semantics, no retry
    expect(foRequests).toBe(1);                                 // single attempt, no key switch
    const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot();
    expect(snap[maskKey(K_FO_SLOW)].totalFailures).toBe(0);     // pool untouched
    expect(snap[maskKey(K_FO_FAST)].totalFailures).toBe(0);
  } finally {
    foGw.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

// ---------------------------------------------------------------------------
// M3 Task 5: GET /health/keys + POST /admin/keys/:keyId/reset
// ---------------------------------------------------------------------------

// threshold 1: one retryable failure cools the primary; cooldown 60s keeps the
// state stable for the whole test so every assertion is deterministic.
const healthCfg = (): AppConfig => ({
  ...cfgBase,
  models: [{
    name: "gpt-4o", provider: "openai",
    api_keys: [{ key: K_FO_SLOW, priority: 1 }, { key: K_FO_FAST, priority: 2 }],
  }],
  aliases: {}, api_keys: {},
  failover: { max_retries: 3, failure_threshold: 1, cooldown_ms: 60_000, latency_window: 10, recovery_successes: 3 },
});

test("M3 health/reset: primary cools down, /health/keys reports it, reset restores selection order", async () => {
  const cfg = healthCfg();
  const hg = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${headersFailUp.port}`;
  const id = maskKey(K_FO_SLOW);
  const health = async () => (await (await fetch(`http://127.0.0.1:${hg.port}/health/keys`)).json()) as any;
  try {
    // Request A: attempt 1 on the primary gets a 500 (threshold 1 -> cooldown),
    // attempt 2 succeeds on the secondary.
    const seenA = headersFailSeen; const primA = headersFailPrimary;
    const a = await postFo(hg.port, streamBody());
    expect((await a.text())).toBe(openaiSseFixture);
    expect(headersFailSeen - seenA).toBe(2);
    expect(headersFailPrimary - primA).toBe(1);                 // primary took the first attempt
    // Request B: the cooling primary is skipped, the secondary serves directly.
    const seenB = headersFailSeen; const primB = headersFailPrimary;
    const b = await postFo(hg.port, streamBody());
    expect((await b.text())).toBe(openaiSseFixture);
    expect(headersFailSeen - seenB).toBe(1);
    expect(headersFailPrimary - primB).toBe(0);                 // cooldown exclusion held

    const h1 = await health();
    const st = h1.models["gpt-4o"][id];
    expect(st.status).toBe("cooldown");
    expect(st.consecutiveFailures).toBe(1);
    expect(st.cooldownRemaining).toBeGreaterThan(0);
    expect(st.cooldownRemaining).toBeLessThanOrEqual(60_000);
    expect(h1.models["gpt-4o"][maskKey(K_FO_FAST)].status).toBe("healthy");
    expect(JSON.stringify(h1)).not.toContain(K_FO_SLOW);        // masked output only
    expect(typeof h1.timestamp).toBe("number");

    // Wrong method on the admin path falls through to the generic 404.
    const wrongMethod = await fetch(`http://127.0.0.1:${hg.port}/admin/keys/${encodeURIComponent(id)}/reset`);
    expect(wrongMethod.status).toBe(404);
    // Unknown keyId -> 404 in the openai error shape (M1 auth-401 precedent).
    const unknown = await fetch(`http://127.0.0.1:${hg.port}/admin/keys/sk-no-such-key-9999/reset`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as any).toEqual({ error: { message: "unknown key id", type: "not_found_error" } });

    const reset = await fetch(`http://127.0.0.1:${hg.port}/admin/keys/${encodeURIComponent(id)}/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await reset.json()) as any).toEqual({ reset: true, keyId: id });

    const h2 = await health();
    expect(h2.models["gpt-4o"][id]).toMatchObject({ status: "healthy", consecutiveFailures: 0, cooldownRemaining: 0 });

    // Request C: the primary is selectable again and takes the first attempt
    // (its 500 is recorded, the secondary still completes the request).
    const seenC = headersFailSeen; const primC = headersFailPrimary;
    const c = await postFo(hg.port, streamBody());
    expect((await c.text())).toBe(openaiSseFixture);
    expect(headersFailSeen - seenC).toBe(2);
    expect(headersFailPrimary - primC).toBe(1);                 // selection order restored
  } finally {
    hg.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("M3 health/reset: auth_token gate covers both endpoints", async () => {
  const cfg = { ...healthCfg(), server: { ...cfgBase.server, port: 0, auth_token: "sec" } };
  const ag = startGateway(cfg);
  const base = `http://127.0.0.1:${ag.port}`;
  try {
    expect((await fetch(`${base}/health/keys`)).status).toBe(401);
    expect((await fetch(`${base}/admin/keys/whatever/reset`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/health/keys`, { headers: { authorization: "Bearer sec" } })).status).toBe(200);
    // Authenticated but unknown id: past the gate, into the 404 branch.
    const admin = await fetch(`${base}/admin/keys/whatever/reset`, { method: "POST", headers: { authorization: "Bearer sec" } });
    expect(admin.status).toBe(404);
  } finally {
    ag.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Per-model base_url (live-test hardening Task 2): upstream prefix without /v1
// ---------------------------------------------------------------------------

// Zhipu-style upstream: the OpenAI-compatible API lives under
// /api/paas/v4/chat/completions — no /v1 segment anywhere. Records the paths
// it was hit on so the test can assert the gateway neither prepends nor
// preserves /v1 for a base_url model.
function startZhipuLikeUpstream() {
  const seen: string[] = [];
  const up = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      seen.push(new URL(req.url).pathname);
      const body = await req.json() as any;
      if (body.stream === true)
        return new Response(openaiSseFixture, { headers: { "content-type": "text/event-stream" } });
      return Response.json({
        id: "chatcmpl-z", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-zhipu" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { up, seen };
}

test("base_url: model with a non-/v1 upstream prefix serves end to end (Zhipu shape)", async () => {
  const { up, seen } = startZhipuLikeUpstream();
  const cfg: AppConfig = {
    ...cfgBase,
    models: [{
      name: "glm-4.6", provider: "openai",
      base_url: `http://127.0.0.1:${up.port}/api/paas/v4`,
      api_keys: [{ key: "sk-zhipu", priority: 1 }],
    }],
    aliases: {}, api_keys: {},
  };
  const bgw = startGateway(cfg);
  try {
    const res = await fetch(`http://127.0.0.1:${bgw.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("from-zhipu");
    expect(seen).toEqual(["/api/paas/v4/chat/completions"]);   // no /v1 injected
  } finally {
    bgw.stop(true);
    up.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Non-stream latency accounting (live-test hardening Task 3): a successful
// non-stream request feeds its measured upstream latency into the key pool,
// so /health/keys reports a nonzero avgLatency
// ---------------------------------------------------------------------------

test("non-stream success feeds measured latency into /health/keys avgLatency", async () => {
  // ~30ms-delayed non-stream upstream: the live-tested symptom was avgLatency
  // staying at 0 after successful non-stream requests; the recorded sample
  // must reflect the measured upstream response-headers time instead.
  const delayedUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      if (body.stream === true)
        return new Response(openaiSseFixture, { headers: { "content-type": "text/event-stream" } });
      await Bun.sleep(30);
      return Response.json({
        id: "chatcmpl-d", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-delayed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  // Fresh cfg object -> fresh KeyPoolRegistry -> untouched pool (WeakMap cache).
  const cfg: AppConfig = {
    ...cfgBase,
    models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-delayed", priority: 1 }] }],
    aliases: {}, api_keys: {},
  };
  const dgw = startGateway(cfg);
  const prevUp = process.env.O2A2O_UPSTREAM_OPENAI;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${delayedUp.port}`;
  try {
    const res = await postFo(dgw.port, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect((await res.json() as any).choices[0].message.content).toBe("from-delayed");
    const health = await (await fetch(`http://127.0.0.1:${dgw.port}/health/keys`)).json() as any;
    expect(health.models["gpt-4o"][maskKey("sk-delayed")].avgLatency).toBeGreaterThan(0);
  } finally {
    dgw.stop(true);
    delayedUp.stop(true);
    process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  }
});

test("base_url: streaming requests reach the custom prefix and pass through", async () => {
  const { up, seen } = startZhipuLikeUpstream();
  const cfg: AppConfig = {
    ...cfgBase,
    models: [{
      name: "glm-4.6", provider: "openai",
      base_url: `http://127.0.0.1:${up.port}/api/paas/v4`,
      api_keys: [{ key: "sk-zhipu", priority: 1 }],
    }],
    aliases: {}, api_keys: {},
  };
  const bgw = startGateway(cfg);
  try {
    const res = await fetch(`http://127.0.0.1:${bgw.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(openaiSseFixture);           // byte-identical passthrough
    expect(seen).toEqual(["/api/paas/v4/chat/completions"]);
  } finally {
    bgw.stop(true);
    up.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Per-model upstream_format: "chat" (finding 4): chat-only openai upstreams
// (Zhipu /api/paas/v4 — no /v1/responses) serve inbound /v1/responses via the
// IR conversion path to the chat endpoint, instead of the same-provider
// passthrough to an upstream /v1/responses that would 404. base_url and
// upstream_format are orthogonal and stack, mirroring the real Zhipu shape.
// ---------------------------------------------------------------------------

// Serves the chat shape under /chat/completions and the responses shape under
// /responses, recording every hit's path + parsed body so the tests can assert
// which endpoint and wire format the gateway actually chose.
function startFormatSpyUpstream() {
  const seen: { path: string; body: any }[] = [];
  const up = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json() as any;
      seen.push({ path, body });
      if (path.endsWith("/responses")) {
        if (body.stream === true)
          return new Response(responsesSseFixture, { headers: { "content-type": "text/event-stream" } });
        return Response.json({
          id: "resp_z", object: "response", created_at: 1, model: body.model, status: "completed",
          output: [{ id: "msg_z", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "from-responses", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      if (body.stream === true)
        return new Response(openaiSseFixture, { headers: { "content-type": "text/event-stream" } });
      return Response.json({
        id: "chatcmpl-z", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-zhipu" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { up, seen };
}

const formatOverrideCfg = (up: { port: number | undefined }, upstreamFormat?: "chat"): AppConfig => ({
  ...cfgBase,
  models: [{
    name: "glm-4.6", provider: "openai",
    base_url: `http://127.0.0.1:${up.port}/api/paas/v4`,
    ...(upstreamFormat ? { upstream_format: upstreamFormat } : {}),
    api_keys: [{ key: "sk-zhipu", priority: 1 }],
  }],
  aliases: {}, api_keys: {},
});

test("upstream_format chat: responses inbound hits the chat endpoint with a chat body, client sees responses output", async () => {
  const { up, seen } = startFormatSpyUpstream();
  const ogw = startGateway(formatOverrideCfg(up, "chat"));
  try {
    const res = await fetch(`http://127.0.0.1:${ogw.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "hi", max_output_tokens: 77 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe("response");
    expect(body.output[0].content[0].type).toBe("output_text");
    expect(body.output[0].content[0].text).toBe("from-zhipu");
    expect(seen.map((s) => s.path)).toEqual(["/api/paas/v4/chat/completions"]); // never /responses
    const sent = seen[0].body;
    expect(Array.isArray(sent.messages)).toBe(true);           // chat wire shape
    expect(sent.input).toBeUndefined();
    expect(sent.max_tokens).toBe(77);                          // max_output_tokens mapped through the IR
    expect(sent.model).toBe("glm-4.6");
  } finally {
    ogw.stop(true);
    up.stop(true);
  }
});

test("upstream_format chat: streaming responses inbound sends the chat SSE upstream and emits responses frames", async () => {
  const { up, seen } = startFormatSpyUpstream();
  const ogw = startGateway(formatOverrideCfg(up, "chat"));
  try {
    const res = await fetch(`http://127.0.0.1:${ogw.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "hi", stream: true }),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(seen.map((s) => s.path)).toEqual(["/api/paas/v4/chat/completions"]);
    expect(seen[0].body.stream).toBe(true);                    // upstream got the SSE chat request
    expect(text).toContain('"type":"response.output_text.delta"');
    expect(text).toContain("stream-hello");
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain("chat.completion.chunk");       // no raw chat frames leak to the client
  } finally {
    ogw.stop(true);
    up.stop(true);
  }
});

test("upstream_format chat: chat inbound still passes through untouched (the override never fires on the chat path)", async () => {
  const { up, seen } = startFormatSpyUpstream();
  const ogw = startGateway(formatOverrideCfg(up, "chat"));
  try {
    const res = await fetch(`http://127.0.0.1:${ogw.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], presence_penalty: 0.5 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).choices[0].message.content).toBe("from-zhipu");
    expect(seen.map((s) => s.path)).toEqual(["/api/paas/v4/chat/completions"]);
    expect(seen[0].body.presence_penalty).toBe(0.5);           // untouched body: no chatToIr->irToChat round-trip
    expect(res.headers.get("x-o2a2o-dropped")).toBeNull();     // nothing reported dropped
  } finally {
    ogw.stop(true);
    up.stop(true);
  }
});

test("upstream_format control: without the override, responses inbound still passes through to /responses byte-identically", async () => {
  const { up, seen } = startFormatSpyUpstream();
  const ogw = startGateway(formatOverrideCfg(up));             // no upstream_format
  try {
    const res = await fetch(`http://127.0.0.1:${ogw.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "hi", stream: true }),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(responsesSseFixture);        // byte-identical passthrough
    expect(seen.map((s) => s.path)).toEqual(["/api/paas/v4/responses"]);
  } finally {
    ogw.stop(true);
    up.stop(true);
  }
});
