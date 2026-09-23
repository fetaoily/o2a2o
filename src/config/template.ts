export const CONFIG_TEMPLATE = `server:
  port: 8080
  host: "127.0.0.1"
  log_level: "info"
  # auth_token: "change-me"   # optional; REQUIRED when host is not loopback.
  #                           # clients then send "Authorization: Bearer <token>"

# Models in service. provider: "openai" | "anthropic"
# base_url (optional): full upstream prefix INCLUDING the version segment,
# for upstreams whose paths lack /v1. The gateway appends the method path
# (e.g. /chat/completions). Precedence: model.base_url > O2A2O_UPSTREAM_*
# env vars > provider default.
models:
  - name: "gpt-4o"
    provider: "openai"
    api_keys:
      - key: "\${OPENAI_KEY_1}"
        priority: 1        # lower number = preferred
        weight: 100
      - key: "\${OPENAI_KEY_2}"
        priority: 2
  - name: "claude-sonnet-4-5"
    provider: "anthropic"
    api_keys:
      - key: "\${ANTHROPIC_KEY_1}"
        priority: 1
# Zhipu (OpenAI-compatible; its endpoint has no /v1 segment) — uncomment to use:
#  - name: "glm-4.6"
#    provider: "openai"
#    base_url: "https://open.bigmodel.cn/api/paas/v4"   # -> /api/paas/v4/chat/completions
#    api_keys:
#      - key: "\${ZHIPU_KEY}"
#        priority: 1

aliases:
  "sonnet": "claude-sonnet-4-5"

# Global fallback keys (lowest priority)
api_keys:
  openai: "\${OPENAI_API_KEY}"
  anthropic: "\${ANTHROPIC_API_KEY}"

# Failover across api keys.
failover:
  max_retries: 3            # attempts across keys per request
  failure_threshold: 3      # consecutive failures -> cooldown
  cooldown_ms: 300000       # 5 min
  latency_window: 10        # rolling latency samples per key
  recovery_successes: 3     # consecutive successes to leave cooldown

# Request timeouts in milliseconds
timeout:
  non_stream:
    default: 60000
    by_model:
      "gpt-4o": 120000
    by_request:
      ms_per_token: 100
      min: 30000
      max: 300000
  stream:
    first_packet: 30000
    idle: 60000
    idle_check_interval: 10000
    idle_grace_period: 5000
    total_max: 600000

# Self-update via GitHub Releases (o2a2o update)
update:
  enabled: true
  repo: "fetaoily/o2a2o"      # GitHub repo serving Releases
  check_on_start: true        # print a notice on serve when a newer release exists
  allow_prerelease: true
`;
