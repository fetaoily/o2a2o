# o2a2o

o2a2o is a lightweight protocol-conversion gateway for LLM APIs, built on [Bun](https://bun.sh).
It exposes OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`),
and Anthropic Messages (`/v1/messages`) on one port and converts any incoming format to any
configured provider, so an OpenAI SDK client can transparently call a Claude model — and vice
versa. Conversion goes through a shared internal representation (IR); same-provider requests
pass through untouched.

## Scope (M1 + M2)

**Supported**

- Non-streaming conversion between the three formats above via the shared IR
- SSE streaming conversion between the three formats (`"stream": true`): the upstream
  stream is parsed per source format, converted through a shared stream event hub, and
  re-encoded in the client's format (openai formats end with `data: [DONE]`, anthropic
  with `message_stop`); same-format streams pass through byte-transparent
- `x-o2a2o-output-format` works on streams too — it selects the response encoder
  (and the passthrough when it matches the upstream's native shape)
- Same-provider passthrough (zero conversion), non-streaming and streaming
- Model-driven routing with aliases (request any model name; aliases map to configured models)
- Dynamic API keys, resolved per request with precedence:
  `x-o2a2o-openai-key` / `x-o2a2o-anthropic-key` header > `o2a2o_keys` in the request body > config keys
- Optional bearer auth (`server.auth_token`; required when binding a non-loopback host)
- `GET /v1/models` in either ecosystem shape (OpenAI by default, Anthropic when the request
  carries `x-api-key` or `anthropic-version`)
- Errors rendered in the client's own format; unsupported parameters reported via
  `x-o2a2o-dropped` (on streaming responses too)
- Dynamic timeouts (config `timeout`):
  non-stream requests resolve `timeout.non_stream` as `by_model` > `max_tokens` estimation
  (`ms_per_token`, clamped to `by_request.min/max`) > `default`;
  streams are watched in three stages from `timeout.stream` — `first_packet` (retryable),
  `idle`, `total_max` (partial output is delivered, then the stream closes). The idle
  check samples periodically, so an idle abort fires after roughly
  `idle + idle_grace_period + idle_check_interval` (~75s at defaults)
- CLI: `serve`, `config init|validate|routes`, `convert`, `version`

**Not yet (roadmap M3/M4)**

- Multi-key failover and per-key health pools (M3)
- Auto-update and multi-platform release builds (M4)

## Quick start

```bash
bun install

# Generate a starter config, then edit it: keep the models you use,
# set their provider, and point api_keys at env vars you actually define.
bun run src/index.ts config init > o2a2o.yaml
# `${VAR}` references resolve when the server starts; export every referenced variable (e.g. `export ANTHROPIC_API_KEY=sk-ant-...`).

bun run src/index.ts serve --config o2a2o.yaml
```

Call a Claude model through the gateway using the OpenAI shape:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"reply with ok"}]}'
```

The response comes back as a standard OpenAI Chat Completions body (`choices[0].message.content`);
if `server.auth_token` is set, add `-H "authorization: Bearer <token>"`.

Stream the same call (`-N` disables curl buffering so SSE chunks print as they arrive):

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"reply with ok"}],"stream":true}'
```

The response is `text/event-stream` in the client's own chunk format — the Claude upstream
stream is converted to OpenAI chat chunks ending with `data: [DONE]`.

## CLI

Run via `bun run src/index.ts <command>` (or compile a standalone binary with `bun run build`):

```
o2a2o serve [--config <path>] [--port <n>]   start the gateway (default config: ./o2a2o.yaml)
o2a2o config init                            print a starter config template to stdout
o2a2o config validate <path>                 validate a config file
o2a2o config routes                          list models, aliases and masked keys
o2a2o convert --input <path> [--to <fmt>]    convert a request body between protocols
o2a2o version                                print the version
```

## Upstream overrides

Point the gateway at a proxy or mock upstream via environment variables:

```
O2A2O_UPSTREAM_OPENAI      default: https://api.openai.com
O2A2O_UPSTREAM_ANTHROPIC   default: https://api.anthropic.com
```

## Docs

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — requirements and acceptance scenarios
- [docs/TECH-DESIGN.md](docs/TECH-DESIGN.md) — technical design (IR, routing, key model)
