# o2a2o

o2a2o is a lightweight protocol-conversion gateway for LLM APIs, built on [Bun](https://bun.sh).
It exposes OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`),
and Anthropic Messages (`/v1/messages`) on one port and converts any incoming format to any
configured provider, so an OpenAI SDK client can transparently call a Claude model — and vice
versa. Conversion goes through a shared internal representation (IR); same-provider requests
pass through untouched.

## Scope (M1 + M2 + M3 + M4)

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
  `x-o2a2o-openai-key` / `x-o2a2o-anthropic-key` header > `o2a2o_keys` in the request body >
  the model's configured key pool (see [Multi-key failover](#multi-key-failover-and-health-m3))
- Multi-key failover with per-model health pools: keys are scored per request
  (priority, weight, health, latency, failure streak, rotation), cooled down after
  repeated key-level failures and progressively recovered; requests fail over across
  keys automatically — streaming requests up to the upstream's first byte only
- Monitoring endpoints `GET /health/keys` and `POST /admin/keys/:keyId/reset`
  (both behind `server.auth_token` when set) — see below
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
- CLI: `serve`, `config init|validate|routes`, `convert`, `update`, `version`
- Self-update from GitHub Releases (M4): `o2a2o update` plus an optional
  startup check — checksum-verified download, atomic in-place replace with
  automatic rollback (see [Auto-update and installation](#auto-update-and-installation-m4))

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
o2a2o update                                 check GitHub Releases and self-update the binary
o2a2o version                                print the version
```

## Upstream overrides

Point the gateway at a proxy or mock upstream via environment variables:

```
O2A2O_UPSTREAM_OPENAI      default: https://api.openai.com
O2A2O_UPSTREAM_ANTHROPIC   default: https://api.anthropic.com
```

## Multi-key failover and health (M3)

Each model's configured keys form one health pool, tuned by the `failover` config
section (`max_retries`, `failure_threshold`, `cooldown_ms`, `latency_window`,
`recovery_successes`). Before every attempt the pool scores its available keys from
priority, weight, health state, rolling average latency, the consecutive-failure
count and time since last use, and the best-scoring key serves the request. After
`failure_threshold` consecutive **key-level** failures (network errors, upstream
timeouts, 5xx, 429, 401/403) a key enters cooldown for `cooldown_ms`; an expired
cooldown returns the key as `degraded`, and `recovery_successes` consecutive
successes promote it back to `healthy`. If every key is cooling down, the key
with the lowest `priority` value (the primary) is force-tried so the request
still goes out. **Request-level**
failures (400/422) are the request's fault, not the key's: they are returned to the
client unchanged and never demote a key. Note: a single failure costs more than
the priority bonus of a narrow priority gap — with adjacent priorities (the
documented default) failover switches keys; a priority gap larger than 10 may
keep a failed primary winning on score until cooldown.

Streaming requests fail over the same way during establishment: as long as the
client has received zero bytes, a failing attempt (connection error, non-2xx
response headers, or the `timeout.stream.first_packet` budget) is retried on the
pool's next key. Once the winning key has delivered its first byte the key is
committed — idle/total timeouts and mid-stream errors surface in-band and never
switch keys (no duplicated partial output).

Dynamic keys (`x-o2a2o-*` header / `o2a2o_keys` body field) bypass the pool: they
get a single attempt with no health accounting.

Monitoring endpoints: both sit behind the same bearer auth gate as the gateway —
when `server.auth_token` is set, send `authorization: Bearer <token>` or get a 401:

- `GET /health/keys` — per-model key states keyed by masked key id, each with
  `status` (`healthy` / `degraded` / `cooldown`), `consecutiveFailures`,
  `totalFailures`, `avgLatency` (ms) and `cooldownRemaining` (ms).
- `POST /admin/keys/:keyId/reset` — return a key to `healthy`, clearing its
  failure streak and cooldown; latency history and the lifetime failure count are
  kept. An unknown key id answers 404. A reset is not an opt-out: a key that
  keeps failing re-enters cooldown after another `failure_threshold` consecutive
  failures. `:keyId` is the masked id exactly as `GET /health/keys` reports it —
  plain ASCII, URL-safe by construction, so no percent-encoding is needed.

Example: the primary key is invalid, the backup takes over transparently, health
shows the cooled-down primary (default threshold: 3 consecutive failures), then an
operator resets it:

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $O2A2O_TOKEN" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"reply with ok"}]}'
# answered by the backup key; each failed primary attempt is recorded

curl -s http://127.0.0.1:8080/health/keys -H "authorization: Bearer $O2A2O_TOKEN"
# {"timestamp":1790...,"models":{"claude-sonnet-4-5":{"sk-ant-a...x9Q2":
#  {"status":"cooldown","consecutiveFailures":3,"totalFailures":3,
#   "avgLatency":0,"cooldownRemaining":241000}}}}

curl -s -X POST http://127.0.0.1:8080/admin/keys/sk-ant-a...x9Q2/reset \
  -H "authorization: Bearer $O2A2O_TOKEN"
# {"reset":true,"keyId":"sk-ant-a...x9Q2"}
```

## Auto-update and installation (M4)

`o2a2o update` self-updates the binary from GitHub Releases. It resolves the
`update` config section, queries the repo's releases for a version strictly
newer than the running one (prereleases only when `allow_prerelease` is true)
and, when one exists, installs it without prompting: the asset built for the
running platform/arch is downloaded and verified against the release's
`checksums.txt` (SHA256 — a release without that file is refused outright,
nothing is installed unverified), then the current binary is backed up and
atomically replaced (a running Windows exe is renamed aside, never
overwritten). The new binary must then run `--version` and report the new
version; on any verification failure the previous binary is rolled back
automatically. Set `update.enabled: false` to disable the command.

Separately, `serve` runs one background update check at startup (disable with
`update.check_on_start: false`): it prints a single
`update available: <version>` line when a newer release exists, and never
blocks serving or installs anything.

The `update` config section (all keys optional, defaults shown):

```yaml
update:
  enabled: true
  repo: "fetaoily/o2a2o"      # GitHub repo serving Releases
  check_on_start: true
  allow_prerelease: true      # current releases are RC prereleases
```

### Releases and installers

Releases are built by GitHub Actions, not locally: pushing a `v*` tag triggers
[.github/workflows/release.yml](.github/workflows/release.yml), which builds
natively on all three platforms (no cross-compilation) and publishes a GitHub
prerelease containing the five binaries (`o2a2o-darwin-arm64|x64`,
`o2a2o-linux-arm64|x64`, `o2a2o-windows-x64.exe`), per-platform installers —
Windows zip with `install.ps1`; Linux `deb`/`rpm` plus a `.tar.gz` with a
systemd unit and `install.sh`; macOS `.tar.gz` with a launchd plist — and one
merged `checksums.txt` covering every asset (one sha256 line each). `bun run
release:rc` is the local helper for the safe part: it gates on a green test
suite, a clean tree and tag uniqueness, then tags `v<version>-rc.1` and pushes
it to trigger CI. Current RC downloads:

https://github.com/fetaoily/o2a2o/releases

## Docs

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — requirements and acceptance scenarios
- [docs/TECH-DESIGN.md](docs/TECH-DESIGN.md) — technical design (IR, routing, key model)
