export const CONFIG_TEMPLATE = `server:
  port: 8080
  host: "127.0.0.1"
  log_level: "info"
  # auth_token: "change-me"   # optional; REQUIRED when host is not loopback.
  #                           # clients then send "Authorization: Bearer <token>"

# Models in service. provider: "openai" | "anthropic"
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

# Self-update (implemented in M4):
# update:
#   enabled: true
#   repo: "fetaoily/o2a2o"      # GitHub repo serving Releases
#   check_on_start: true
`;
