// HTTP gateway: routes the three chat endpoints through the unified
// conversion pipeline and renders every error in the client's own format
// (TECH-DESIGN §15.8).
import type { AppConfig } from "./config/loader";
import type { InputFormat } from "./core/format-detector";
import { detectFormat } from "./core/format-detector";
import { handleGatewayRequest, handleGatewayStream, wantsStreaming } from "./core/unified-converter";
import { checkAuth, modelsBody, healthKeysBody, resolveKeyId } from "./core/models-endpoint";
import { ParamError } from "./converters/chat";
import { UpstreamError } from "./core/forwarder";
import { toClientError } from "./converters/errors";

const GATEWAY_PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"];

// detectFormat throws on bodies it cannot fingerprint; for error rendering the
// format is then unknowable, so fall back to the ecosystem default openai_chat.
function detectFormatSafe(path: string, body: Record<string, unknown>): InputFormat {
  try { return detectFormat(path, body); }
  catch { return "openai_chat"; }
}

// openai shape by default; anthropic shape when the request presents an
// anthropic-style credential or version header.
function modelsHandler(cfg: AppConfig, req: Request): Response {
  const anthropicShape = req.headers.has("anthropic-version") || req.headers.has("x-api-key");
  return new Response(JSON.stringify(modelsBody(cfg, anthropicShape)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function startGateway(cfg: AppConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: cfg.server.port, hostname: cfg.server.host,
    async fetch(req) {
      // Auth gate runs before any route dispatch: the client format is not
      // yet knowable, so the 401 always uses the openai error shape.
      const headers = Object.fromEntries(req.headers.entries());
      if (!checkAuth(cfg, headers)) {
        return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(req.url);
      if (req.method === "POST" && GATEWAY_PATHS.includes(url.pathname)) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        try {
          // Stream-truthy requests take the M2 streaming path (1:1: a
          // streaming client always gets a streaming upstream call); the
          // error catch below also covers it — upstream non-2xx throws
          // before the stream is established.
          const out = wantsStreaming(body)
            ? await handleGatewayStream(cfg, url.pathname, body, headers)
            : await handleGatewayRequest(cfg, url.pathname, body, headers);
          if ("stream" in out) {
            const h: Record<string, string> = {
              "content-type": out.contentType,
              "cache-control": "no-cache",
              connection: "keep-alive",
            };
            if (out.droppedParams) h["x-o2a2o-dropped"] = out.droppedParams.join(",");
            return new Response(out.stream, { status: out.status, headers: h });
          }
          const h: Record<string, string> = { "content-type": "application/json" };
          if (out.droppedParams) h["x-o2a2o-dropped"] = out.droppedParams.join(",");
          return new Response(JSON.stringify(out.body), { status: out.status, headers: h });
        } catch (e) {
          const status = e instanceof ParamError ? 400 : e instanceof UpstreamError ? e.status : 500;
          const fmt = detectFormatSafe(url.pathname, body);
          // UpstreamError is wrapped, never passed directly: errors.ts's
          // `instanceof Error` branch would swallow the upstream body.
          const payload = e instanceof UpstreamError ? { upstream: e.status, body: e.body } : e;
          const err = toClientError(status, payload, fmt);
          return new Response(JSON.stringify(err.body), { status: err.status, headers: { "content-type": "application/json" } });
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/models") return modelsHandler(cfg, req);
      // M3 monitoring/admin endpoints: one canonical shape each, so the
      // /v1/models anthropic-shape negotiation does not apply. Both sit behind
      // the auth gate above; non-matching methods fall through to the 404.
      if (req.method === "GET" && url.pathname === "/health/keys")
        return new Response(JSON.stringify(healthKeysBody(cfg)), { status: 200, headers: { "content-type": "application/json" } });
      const resetMatch = req.method === "POST" ? /^\/admin\/keys\/([^/]+)\/reset$/.exec(url.pathname) : null;
      if (resetMatch) {
        const keyId = resetMatch[1]; // masked id, plain ASCII by construction: no decoding
        const pool = resolveKeyId(cfg, keyId);
        if (!pool)
          return new Response(JSON.stringify({ error: { message: "unknown key id", type: "not_found_error" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        pool.resetKey(keyId);
        return new Response(JSON.stringify({ reset: true, keyId }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }), { status: 404 });
    },
  });
}
