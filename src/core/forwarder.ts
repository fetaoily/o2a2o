// Key resolution and upstream forwarding (single-key M1 version).
// Key priority: header > body.o2a2o_keys > lowest-priority model config key >
// provider-wide global key. M1 simplification: modelKeys takes the minimum
// priority across ALL keys of the same provider (no health pool); M3 replaces
// this lookup with ApiKeyPool. Upstream timeout is fixed in M1; dynamic
// calculation arrives in M2.
import type { AppConfig } from "../config/loader";
import { log, warn, error, maskKey } from "../utils/logger";

export type Provider = "openai" | "anthropic";

export class UpstreamError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`upstream returned status ${status}`);
    this.name = "UpstreamError";
  }
}

export const UPSTREAM_TIMEOUT_MS = 60_000;

export function upstreamBase(provider: Provider): string {
  return provider === "openai"
    ? (process.env.O2A2O_UPSTREAM_OPENAI ?? "https://api.openai.com")
    : (process.env.O2A2O_UPSTREAM_ANTHROPIC ?? "https://api.anthropic.com");
}

export function resolveKey(
  cfg: AppConfig,
  provider: Provider,
  headers: Record<string, string | undefined>,
  body: Record<string, unknown>,
): { key: string; body: Record<string, unknown> } {
  const hdrKey = headers[provider === "openai" ? "x-o2a2o-openai-key" : "x-o2a2o-anthropic-key"];
  const { o2a2o_keys, ...rest } = body; // strip ALWAYS, even when key came from elsewhere
  const bodyKey = (o2a2o_keys as Partial<Record<Provider, string>> | undefined)?.[provider];
  const modelKeys = cfg.models.filter((m) => m.provider === provider)
    .flatMap((m) => m.api_keys).sort((a, b) => a.priority - b.priority);
  const key = hdrKey ?? bodyKey ?? modelKeys[0]?.key ?? cfg.api_keys[provider];
  if (!key) throw new Error(`no api key available for provider ${provider}`);
  return { key, body: rest };
}

export async function forwardToUpstream(opts: {
  provider: Provider;
  endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
  body: Record<string, unknown>;
  key: string;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = opts.provider === "anthropic"
      ? { "x-api-key": opts.key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
      : { "authorization": `Bearer ${opts.key}`, "content-type": "application/json" };
    log(`${opts.provider} POST ${opts.endpoint} key=${maskKey(opts.key)}`);
    const res = await fetch(upstreamBase(opts.provider) + opts.endpoint, {
      method: "POST", headers, body: JSON.stringify(opts.body), signal: controller.signal,
    });
    if (!res.ok) {
      error(`${opts.provider} ${opts.endpoint} upstream status ${res.status} key=${maskKey(opts.key)}`);
      throw new UpstreamError(res.status, await res.json().catch(() => ({})));
    }
    return res;
  } catch (e) {
    if (!(e instanceof UpstreamError)) {
      warn(`${opts.provider} ${opts.endpoint} upstream failure key=${maskKey(opts.key)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw e;
  } finally { clearTimeout(timer); }
}
