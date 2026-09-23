// Client-disconnect semantics (live-test hardening Task 1). Four pins, each
// with a discriminating assertion:
//   1. non-stream abort: the upstream observes its own request.signal abort,
//      the gateway keeps serving, and the key pool records no failure;
//   2. establishment-phase abort (upstream headers pending): exactly one
//      upstream attempt, no key switch, an empty closed stream outcome with no
//      error frame, no pool accounting;
//   3. post-first-byte abort: the conversion-chain reader is cancelled, the
//      upstream body cancel is observed by the mock, the stream closes safely
//      and the gateway keeps serving;
//   4. timeout aborts keep the D4 retry/accounting semantics (covered at the
//      forwarder level in forwarder.test.ts and by the untouched M3 failover
//      tests in integration/gateway.test.ts).
// All upstreams are local mocks; nothing leaves the machine.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "../../src/server";
import { handleGatewayStream } from "../../src/core/unified-converter";
import { KeyPoolRegistry } from "../../src/core/forwarder";
import { maskKey } from "../../src/utils/logger";
import type { AppConfig } from "../../src/config/loader";

const K_A = "sk-disc-key-a-aaaaaaaa-1111";
const K_B = "sk-disc-key-b-bbbbbbbb-2222";

const DEF_FAILOVER = { max_retries: 3, failure_threshold: 3, cooldown_ms: 300000, latency_window: 10, recovery_successes: 3 };
// Generous stream budgets: nothing in this file should be raced by a timeout;
// the tests abort the client signal themselves.
const cfgBase: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: K_A, priority: 1 }, { key: K_B, priority: 2 }] }],
  aliases: {}, api_keys: {},
  failover: { ...DEF_FAILOVER },
};
// Fresh cfg per test where pool isolation matters: KeyPoolRegistry caches one
// pool set per cfg object. The non-stream budget is short so a RED run (signal
// wiring missing) times out per attempt in ~1.5s instead of the 60s default;
// every abort in this file lands well inside it.
const freshCfg = (): AppConfig => ({
  ...cfgBase,
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: K_A, priority: 1 }, { key: K_B, priority: 2 }] }],
  timeout: {
    non_stream: { default: 1500, by_model: {}, by_request: { ms_per_token: 100, min: 30000, max: 300000 } },
    stream: { first_packet: 30000, idle: 60000, idle_check_interval: 10000, idle_grace_period: 5000, total_max: 600000 },
  },
});

// ---------------------------------------------------------------------------
// Mock upstreams
// ---------------------------------------------------------------------------

// Pin 1 upstream: hung requests (content "hang") never answer until their own
// request.signal aborts; every other request gets a normal completion. Counts
// aborted hung requests so tests can assert the upstream SAW the cancel.
let hangAborted = 0;
let hangActive = 0;
let hangUp: ReturnType<typeof Bun.serve>;

// Pin 2 upstream: raw sockets that read complete requests and never answer —
// the upstream headers stay pending forever. Counts every complete request.
let rawAttempts = 0;
let rawUp: Bun.TCPSocketListener;

interface RawSockState { buf: string }
const rawSocks = new WeakMap<object, RawSockState>();
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

// Pin 3 upstream: an SSE response that drips one chat chunk per pull and never
// finishes. Its body's cancel() is the observation point for "the gateway
// cancelled the upstream body".
let upstreamBodyCancelled = 0;
let sseUp: ReturnType<typeof Bun.serve>;

const encoder = new TextEncoder();
const sseChunk = (content: string): string =>
  `data: {"id":"chatcmpl-d","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"${content}"}}]}\n\n`;
const SSE_CHUNKS = [
  'data: {"id":"chatcmpl-d","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
  sseChunk("chunk-1"), sseChunk("chunk-2"), sseChunk("chunk-3"),
  sseChunk("chunk-4"), sseChunk("chunk-5"), sseChunk("chunk-6"),
];

beforeAll(() => {
  hangUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      if (body.messages?.[0]?.content === "hang") {
        hangActive += 1;
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) { resolve(); return; }
          req.signal.addEventListener("abort", () => { hangAborted += 1; resolve(); }, { once: true });
          setTimeout(resolve, 10000); // safety valve, never hit in these tests
        });
        hangActive -= 1;
        return new Response(null, { status: 499 }); // client is gone either way
      }
      return Response.json({
        id: "chatcmpl-1", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-gpt" }, finish_reason: "stop" }],
      });
    },
  });
  rawUp = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    data: {},
    socket: {
      data(socket, chunk) {
        const st = rawSocks.get(socket) ?? { buf: "" };
        st.buf += Buffer.from(chunk).toString("latin1");
        rawSocks.set(socket, st);
        for (;;) {
          if (takeRawRequest(socket) === null) return;
          rawAttempts += 1; // read the request, answer nothing: headers stay pending
        }
      },
      error() {},
    },
  });
  sseUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      // Non-stream bodies get a normal completion, so the tests' "gateway
      // keeps serving" checks do not hang on the never-ending stream below.
      const body = await req.json() as any;
      if (body.stream !== true) {
        return Response.json({
          id: "chatcmpl-1", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "from-gpt" }, finish_reason: "stop" }],
        });
      }
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < SSE_CHUNKS.length) {
            controller.enqueue(encoder.encode(SSE_CHUNKS[i++]));
            return;
          }
          // Hold the stream open forever (a slow upstream mid-generation).
          // Returning without enqueueing would re-invoke pull immediately and
          // spin the CPU; a never-resolving pull keeps it parked instead.
          return new Promise<void>(() => {});
        },
        cancel() { upstreamBodyCancelled += 1; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => {
  hangUp.stop(true); rawUp.stop(true); sseUp.stop(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let prevUp = "";
const useUpstream = (port: number | undefined): void => {
  prevUp = process.env.O2A2O_UPSTREAM_OPENAI ?? "";
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${port}`;
};
const restoreUpstream = (): void => {
  if (prevUp) process.env.O2A2O_UPSTREAM_OPENAI = prevUp;
  else delete process.env.O2A2O_UPSTREAM_OPENAI;
};

const until = async (fn: () => boolean, budgetMs = 3000): Promise<void> => {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(10);
  }
};

const readAll = async (s: ReadableStream<Uint8Array>): Promise<string> => {
  const r = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
};

// Sum of every key's totalFailures across every model in the health body.
const healthTotalFailures = async (port: number | undefined): Promise<number> => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health/keys`)).json() as any;
  let sum = 0;
  for (const model of Object.values<any>(h.models))
    for (const st of Object.values<any>(model)) sum += st.totalFailures ?? 0;
  return sum;
};

const poolFailureSum = (cfg: AppConfig): number => {
  const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot() as Record<string, any>;
  let sum = 0;
  for (const [k, v] of Object.entries(snap)) if (k !== "keys") sum += v.totalFailures ?? 0;
  return sum;
};

const poolSampleSum = (cfg: AppConfig): number => {
  const snap = KeyPoolRegistry.from(cfg).poolFor(cfg.models[0]).snapshot() as Record<string, any>;
  let sum = 0;
  for (const [k, v] of Object.entries(snap)) if (k !== "keys") sum += (v.latencySamples?.length ?? 0);
  return sum;
};

const chatBody = (content = "hi") => ({ model: "gpt-4o", messages: [{ role: "user", content }] });
const post = (port: number | undefined, p: string, b: unknown, signal?: AbortSignal, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...h },
    body: JSON.stringify(b),
  });

// ---------------------------------------------------------------------------
// Pin 1: non-stream abort
// ---------------------------------------------------------------------------

test("P1 non-stream abort: upstream sees its signal aborted, pool untouched, gateway keeps serving", async () => {
  useUpstream(hangUp.port);
  const gw = startGateway(freshCfg());
  try {
    const before = await healthTotalFailures(gw.port);
    const ac = new AbortController();
    const p = post(gw.port, "/v1/chat/completions", chatBody("hang"), ac.signal);
    p.catch(() => {}); // the client-side rejection is expected; no unhandled rejection
    await until(() => hangActive >= 1); // the upstream is now hung on this request
    ac.abort();
    await until(() => hangAborted >= 1); // the upstream observed its own request.signal fire
    expect(hangAborted).toBeGreaterThanOrEqual(1);
    await expect(p).rejects.toThrow();
    expect(await healthTotalFailures(gw.port)).toBe(before); // no recordFailure anywhere

    // The gateway process survived the disconnect and keeps serving.
    const ok = await post(gw.port, "/v1/chat/completions", chatBody("normal"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).choices[0].message.content).toBe("from-gpt");
  } finally {
    gw.stop(true);
    restoreUpstream();
  }
});

// ---------------------------------------------------------------------------
// Pin 2: establishment-phase abort (upstream headers pending)
// ---------------------------------------------------------------------------

test("P2 establishment abort (unit): one attempt, empty closed stream, no pool accounting", async () => {
  useUpstream(rawUp.port);
  try {
    const cfg = freshCfg();
    rawAttempts = 0;
    const ac = new AbortController();
    const p = handleGatewayStream(cfg, "/v1/chat/completions", { ...chatBody(), stream: true }, {}, ac.signal);
    await until(() => rawAttempts >= 1); // the attempt is in flight, headers pending
    await Bun.sleep(30);
    ac.abort();
    const out = await p;
    expect("stream" in out).toBe(true);
    // Empty, immediately-closed stream: no error frame (the client is gone),
    // no retries buffered anywhere.
    expect(await readAll((out as any).stream)).toBe("");
    expect(rawAttempts).toBe(1); // exactly one upstream attempt, no key switch
    expect(poolFailureSum(cfg)).toBe(0);
    expect(poolSampleSum(cfg)).toBe(0);
  } finally {
    restoreUpstream();
  }
});

test("P2 establishment abort (HTTP): one upstream attempt, no pool accounting, gateway alive", async () => {
  useUpstream(rawUp.port);
  const cfg = freshCfg();
  const gw = startGateway(cfg);
  try {
    rawAttempts = 0;
    const before = await healthTotalFailures(gw.port);
    const ac = new AbortController();
    const p = post(gw.port, "/v1/chat/completions", { ...chatBody(), stream: true }, ac.signal);
    p.catch(() => {});
    await until(() => rawAttempts >= 1);
    ac.abort();
    await expect(p).rejects.toThrow();
    // Wait out the short per-attempt budget: with the wiring missing (RED) the
    // establishment loop keeps timing out and retrying, which surfaces here as
    // extra upstream attempts and recorded key failures.
    await Bun.sleep(2000);
    expect(rawAttempts).toBe(1);
    expect(await healthTotalFailures(gw.port)).toBe(before);
  } finally {
    gw.stop(true);
    restoreUpstream();
  }
});

// ---------------------------------------------------------------------------
// Pin 3: post-first-byte abort
// ---------------------------------------------------------------------------

test("P3 post-first-byte abort: upstream body cancelled, conversion chain torn down, gateway keeps serving", async () => {
  useUpstream(sseUp.port);
  const gw = startGateway(freshCfg());
  try {
    upstreamBodyCancelled = 0;
    // Cross-format: anthropic client -> openai upstream exercises convertStream.
    const ac = new AbortController();
    const res = await post(gw.port, "/v1/messages",
      { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }], stream: true },
      ac.signal, { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read(); // the client received the first byte
    expect(first.done).toBe(false);
    ac.abort();
    await until(() => upstreamBodyCancelled >= 1); // the mock saw its body cancelled
    expect(upstreamBodyCancelled).toBeGreaterThanOrEqual(1);

    // The gateway survived and keeps serving.
    const ok = await post(gw.port, "/v1/chat/completions", chatBody("normal"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).choices[0].message.content).toBe("from-gpt");
  } finally {
    gw.stop(true);
    restoreUpstream();
  }
});

test("P3 post-first-byte abort (unit, same-format pipeThrough): stream closes safely, upstream body cancelled", async () => {
  useUpstream(sseUp.port);
  try {
    upstreamBodyCancelled = 0;
    const cfg = freshCfg();
    const ac = new AbortController();
    const out = await handleGatewayStream(cfg, "/v1/chat/completions", { ...chatBody(), stream: true }, {}, ac.signal);
    expect("stream" in out).toBe(true);
    const reader = ((out as any).stream as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false); // first byte delivered to the client
    ac.abort();
    await until(() => upstreamBodyCancelled >= 1); // conversion chain cancelled the upstream body
    // The client stream closes safely (no hang, no error): the next read is done.
    const next = await reader.read();
    expect(next.done).toBe(true);
    expect(poolFailureSum(cfg)).toBe(0);
  } finally {
    restoreUpstream();
  }
});
