// HTTP gateway: routes the three chat endpoints through the unified
// conversion pipeline and renders every error in the client's own format
// (TECH-DESIGN §15.8).
import type { AppConfig } from "./config/loader";
import type { InputFormat } from "./core/format-detector";
import { detectFormat } from "./core/format-detector";
import { handleGatewayRequest } from "./core/unified-converter";
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

// Task 11 fills in the real model listing; interim placeholder returns 501.
function modelsHandler(_cfg: AppConfig, _req: Request): Response {
  return new Response(JSON.stringify({ error: { message: "not implemented", type: "api_error" } }), {
    status: 501,
    headers: { "content-type": "application/json" },
  });
}

export function startGateway(cfg: AppConfig): Bun.Server {
  return Bun.serve({
    port: cfg.server.port, hostname: cfg.server.host,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && GATEWAY_PATHS.includes(url.pathname)) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const headers = Object.fromEntries(req.headers.entries());
        try {
          const out = await handleGatewayRequest(cfg, url.pathname, body, headers);
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
      return new Response(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }), { status: 404 });
    },
  });
}
