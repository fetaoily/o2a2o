# O2A2O 技术方案

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-21 |
| 配套需求 | [REQUIREMENTS.md](./REQUIREMENTS.md) |

## 1. 技术栈

| 组件 | 选择 | 理由 |
|---|---|---|
| 运行时 | Bun | `bun build --compile` 产出单文件可执行程序；性能优于 Node.js；与 Claude Code 独立版同栈 |
| 语言 | TypeScript（strict） | 类型安全；IR 与转换器受强类型约束 |
| HTTP 服务 | `Bun.serve`（原生） | 无额外框架依赖；原生支持流式响应 |
| 配置 | YAML | 人工可读可维护 |
| 测试 | `bun test` | 内置，无额外依赖 |
| 分发 | GitHub Releases | 成熟；支持多平台产物与校验和 |

## 2. 总体架构

```
                client (OpenAI SDK / Anthropic SDK / curl)
                                    |
        +---------------------------+----------------------------+
        | /v1/chat/completions  /v1/responses  /v1/messages      |
        v
+--------------------------------------------------------------+
|  FormatDetector   path + body fingerprint -> input format    |
|  ModelRouter      alias resolve -> model -> provider         |
|                   same provider => passthrough               |
+--------------------------------------------------------------+
        | cross-protocol                                  ^ response
        v                                                 | back to
+------------------+     +------------------+              | client
|  Request  -> IR  |     |  IR -> Request   |              |
|  (to target fmt) |     |  (to client fmt) |              |
+------------------+     +------------------+              |
        |                                                  |
        v                                                  |
+--------------------------------------------------------------+
|  SmartForwarder                                              |
|    ApiKeyPool (score -> best key)                            |
|    TimeoutCalculator / StreamTimeoutManager                  |
|    failover: retry next key on retryable errors              |
+--------------------------------------------------------------+
        |
        +------------------>  api.openai.com / api.anthropic.com
```

一次跨协议请求的数据流：

1. 客户端请求到达（三端点之一）；
2. FormatDetector 识别请求格式；ModelRouter 解析别名、查配置得到模型 provider；同 provider → 直通转发；
3. 跨协议：请求 → IR → 目标格式；
4. SmartForwarder 取最优 Key，按动态超时执行转发；可重试失败自动换 Key；
5. 上游响应（或 SSE 流）→ IR → 客户端请求时的格式（或 `x-o2a2o-output-format` 指定格式）返回；
6. 全程回写 Key 健康（成功延迟 / 失败次数）与延迟统计。

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 统一中间表示 IR，而非格式两两直转 | OpenAI 有两套对外接口，两两直转是组合爆炸；IR 使 N 种格式只需 O(N) 组转换器，且为 Gemini 扩展预留 |
| D2 | 模型驱动路由，不设显式路由表 | 配置只声明模型（name + provider）；方向由「请求格式 ↔ 模型 provider」自动推导，消除配置出错面 |
| D3 | 同协议直通（passthrough） | 不经 IR 往返，避免转换开销与字段语义损耗 |
| D4 | 401/403 按 Key 级失败处理 | 换 Key 重试并累计失败——多 Key 池的核心价值；400/422 请求错误不重试，直接返回客户端 |
| D5 | 流式空闲超时不重试 | 上游可能已部分生成/计费，重发会导致重复输出；返回已生成部分 |
| D6 | 更新 = 备份 + 原子替换 + 自验证回滚 | 防止半成品二进制导致程序不可启动 |

## 4. 中间表示（IR）

`src/types/ir.ts` —— 两侧协议字段的公共超集。每种格式只需实现「格式 ↔ IR」，即得任意格式间互转：

```
openai_chat       <-->  IR  <-->  anthropic
openai_responses  <-->  IR
```

每种格式实现 4 个纯函数：

- 请求方向：`formatToIR(body) => IRRequest`、`irToFormat(ir) => body`
- 响应方向：`responseToIR(body) => IRResponse`、`irToResponse(ir) => body`

```typescript
// src/types/ir.ts (sketch)
interface IRRequest {
  model: string;
  system?: string;              // hoisted system prompt
  messages: IRMessage[];
  tools?: IRTool[];
  toolChoice?: "auto" | "none" | { name: string };
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  stream?: boolean;
}

interface IRMessage {
  role: "user" | "assistant" | "tool";
  content: string | IRContentPart[];
}

type IRContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }        // base64 or url ref
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: unknown };

interface IRTool {
  name: string;
  description?: string;
  parameters: unknown;          // JSON Schema
}

interface IRResponse {
  id: string;
  model: string;
  content: IRContentPart[];     // text / tool_use
  stopReason?: string;          // normalized: stop | length | tool_use | ...
  usage: { inputTokens: number; outputTokens: number };
}
```

映射要点：

- **system**：OpenAI `messages` 中 `role: "system"` 的消息提升到 `IR.system`；回程时还原回对应位置（openai_chat 首条消息 / anthropic 顶层 `system` 字段）；
- **max_tokens**：Anthropic 必填；客户端未传时在 IR 层填默认值 4096；
- **stop_reason 归一化（枚举已核实，见 §18）**：anthropic `end_turn | stop_sequence | max_tokens | tool_use | refusal | pause_turn` ↔ openai `finish_reason: stop | length | tool_calls | content_filter`。映射：`end_turn`/`stop_sequence` → `stop`；`max_tokens` → `length`；`tool_use` ↔ `tool_calls`；`refusal` ↔ `content_filter`（近似语义）；`pause_turn` → `stop` 并记 warn（openai 无对应语义，网关不自动续传）；
- **usage**：`total_tokens = input_tokens + output_tokens`；
- **tool calling**：tools 定义 `parameters`（JSON Schema）↔ `input_schema`；调用块 `tool_calls[].function` ↔ `tool_use`；工具结果 `role:"tool"` 消息 ↔ `tool_result` 内容块。

## 5. 格式识别与路由

`src/core/format-detector.ts` + `src/core/unified-converter.ts`

路径优先，body 特征兜底：

| 判定 | 条件 |
|---|---|
| openai_chat | path = `/v1/chat/completions` |
| openai_responses | path = `/v1/responses` |
| anthropic | path = `/v1/messages` |
| 兜底 → responses | `body.input !== undefined` |
| 兜底 → chat | `body.messages[0]?.role` 存在 |
| 兜底 → anthropic | `body.messages` 为数组且 `body.max_tokens` 存在 |

路由推导：

```typescript
const provider = resolveAlias(body.model)      // alias -> canonical name
                 |> config.getModel            // -> { provider }
const source = formatToProvider(inputFormat);  // chat/responses -> openai
const direction = provider === source ? "pass" : provider === "anthropic" ? "o2a" : "a2o";
```

未配置的模型 → 400，错误体按请求方协议格式生成。

## 6. 配置文件

### 6.1 完整示例（`examples/o2a2o.yaml`）

```yaml
server:
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
      - key: "${OPENAI_KEY_1}"
        priority: 1        # lower number = preferred
        weight: 100
      - key: "${OPENAI_KEY_2}"
        priority: 2
  - name: "claude-sonnet-4-5"
    provider: "anthropic"
    api_keys:
      - key: "${ANTHROPIC_KEY_1}"
        priority: 1

aliases:
  "sonnet": "claude-sonnet-4-5"

# Global fallback keys (lowest priority)
api_keys:
  openai: "${OPENAI_API_KEY}"
  anthropic: "${ANTHROPIC_API_KEY}"

# Failover across api keys.
failover:
  max_retries: 3            # attempts across keys per request
  failure_threshold: 3      # consecutive failures -> cooldown
  cooldown_ms: 300000       # 5 min
  latency_window: 10        # rolling latency samples per key
  recovery_successes: 3     # consecutive successes to leave cooldown

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

update:
  enabled: true
  repo: "fetaoily/o2a2o"      # GitHub repo serving Releases
  check_on_start: true
```

### 6.2 加载与校验（`src/config/`）

- `${VAR}` 环境变量解析；变量未定义 → 启动失败并指明字段路径；
- 上游地址可通过环境变量覆盖（默认官方端点，用于测试与 OpenAI/Anthropic 兼容网关）：
  - `O2A2O_UPSTREAM_OPENAI`（默认 `https://api.openai.com`）
  - `O2A2O_UPSTREAM_ANTHROPIC`（默认 `https://api.anthropic.com`）
- 校验规则：`models` 非空、`provider` 取值合法、`name` 唯一、别名不成环、数值字段范围合法；
- `o2a2o config validate` 与启动加载复用同一校验器；
- `o2a2o config init` 输出此模板。

## 7. API Key 池与故障转移

`src/core/api-key-pool.ts`

### 7.1 健康状态机

```
healthy --(consecutive failures >= threshold)--> cooldown
cooldown --(cooldown expired)--> degraded --(consecutive successes)--> healthy
```

### 7.2 选 Key 评分（取最高分者）

```
score = (100 - priority) * 10        # priority bonus
      + weight
      + healthBonus                  # healthy +1000 / degraded +500 / cooldown 0
      - min(avgLatency / 10, 500)    # latency penalty
      - consecutiveFailures * 100
      + (lastUsed > 60s ago ? 50 : 0)   # rotation bonus, avoids starvation
```

### 7.3 行为规则

- `recordSuccess(key, latencyMs)`：连败清零；滚动窗口（默认 10 次）更新平均延迟；
- `recordFailure(key)`：连败 +1；达阈值进入冷却（`now + cooldown_ms`）；
- 所有 Key 均不可用时：兜底选 priority 最小者强制尝试（可用性优先）；
- 请求头/请求体动态传入的 Key 不入池，直接使用；
- 日志与 `/health/keys` 输出对 Key 掩码：`mask(key) = key.slice(0,8) + "..." + key.slice(-4)`。

## 8. 超时管理

### 8.1 非流式动态超时（`src/core/timeout-calculator.ts`）

```
timeout = by_model[model] ?? default
if (!stream && max_tokens):
    timeout = clamp(max_tokens * ms_per_token, min, max)
timeout = max(timeout, avgLatency(model) * 3)   # adaptive from history
```

超时中断 → `TimeoutError`，按可重试处理（换 Key）。

### 8.2 流式三阶段（`src/core/stream-timeout-manager.ts`）

| 阶段 | 定时器 | 触发动作 |
|---|---|---|
| 首包 | `first_packet`（30s） | abort；`TimeoutError(stage="first_packet", retryable=true)` |
| 空闲 | 每 `idle_check_interval` 检查 `now - lastDataTime` | 超过 `idle + grace` → abort；`retryable=false`，返回已聚合的部分结果 |
| 总时长 | `total_max`（10min） | abort；`retryable=false`，强制终止 |

实现要点：

- 首个 chunk 到达即撤销首包定时器，记录 `firstPacketLatency` 回写 Key 评分；
- `reader.read()` 循环内持续刷新 `lastDataTime`；
- SSE 事件按行缓冲跨 chunk 拼接后再解析（事件可能被 TCP 分块切断，不完整行不得提前解析）；
- `TimeoutError` 携带 `stage` 字段，供故障转移决策。

## 9. 智能转发器

`src/core/smart-forwarder.ts`，流式事件回调接口：

```typescript
type StreamEvent =
  | { type: "first_packet"; latencyMs: number }
  | { type: "data"; data: unknown }        // one parsed SSE payload
  | { type: "done" }
  | { type: "error"; error: TimeoutError | ApiError; retryable: boolean }
  | { type: "warning"; message: string }   // e.g. idle approaching
  | { type: "parse_error"; raw: string };
```

重试判定表：

| 错误 | 换 Key 重试 | 说明 |
|---|---|---|
| 网络错误（ECONNRESET / ETIMEDOUT） | ✅ | |
| 非流式整体超时 / 流式首包超时 | ✅ | |
| 5xx / 429 | ✅ | 429 限流 |
| 401 / 403 | ✅ | 同时累计该 Key 失败 |
| 400 / 422 | ❌ | 请求级错误，直接映射返回客户端 |
| 流式空闲 / 总时长超时 | ❌ | 返回已生成部分 |

流程：循环 `max_retries` 次 { 取最优 Key → 执行 → 成功则 `recordSuccess` 返回；失败则 `recordFailure`，按判定表决定重试或抛出 }。

## 10. 流式响应输出

- 服务端以 `ReadableStream` + `Content-Type: text/event-stream` 返回；
- 上游 SSE 事件 → 流式转换器映射为目标格式 chunk → 逐块 enqueue，不整体缓冲；
- 结束时按目标格式发送终止标记（openai_chat/openai_responses: `data: [DONE]`；anthropic: `message_stop` 事件）；
- 中途错误：发送该格式约定的错误事件后关闭流。

事件映射（**已于 2026-09-21 对照官方文档逐项核实**，来源清单见 §18）：

| 语义 | anthropic（SSE `event:` 名） | openai_chat（`chat.completion.chunk`） | openai_responses（`event.type`） |
|---|---|---|---|
| 流开始 | `message_start`，`message` 对象含 id/type/role/model/`stop_reason:null`/`usage:{input_tokens,output_tokens}` | 首个 chunk，`choices[0].delta.role:"assistant"` | `response.created` → `response.in_progress`（`response` 对象内嵌） |
| 文本增量 | `content_block_delta`，`delta:{type:"text_delta",text}` | `choices[0].delta.content` | `response.output_text.delta`，`delta` 字段 |
| 工具调用开始 | `content_block_start`，`content_block:{type:"tool_use",id,name,input:{}}` | 首个工具增量：`delta.tool_calls[0]{index,id,type:"function",function:{name,arguments:""}}` | `response.output_item.added`（item.type=`function_call`） |
| 工具参数增量 | `content_block_delta`，`delta:{type:"input_json_delta",partial_json}`（JSON 字符串片段累积） | `delta.tool_calls[0].function.arguments` 增量拼接 | `response.function_call_arguments.delta`，`delta` 字段 |
| 内容块 / 部分结束 | `content_block_stop`（带 `index`） | —（无对应，丢弃） | `response.output_text.done` / `response.content_part.done` / `response.output_item.done` |
| 结束 + 终止原因 | `message_delta`，`delta:{stop_reason,stop_sequence}` → `message_stop` | `delta` 为空对象、`finish_reason` 置值的末 chunk，随后发 `data: [DONE]` | `response.completed` / `response.incomplete`（`incomplete_details.reason`）/ `response.failed`（`response.error`） |
| 用量 | `message_start.usage`（初始）+ `message_delta.usage`（**累计值**） | 请求带 `stream_options:{include_usage:true}` 时，流末尾附 `choices:[]` 且含 `usage` 的 chunk | `response.completed.response.usage` |
| 心跳 | `ping`（`data:{"type":"ping"}`，可出现任意次） | —（丢弃） | — |
| 流中错误 | `event: error`，`data:{"type":"error","error":{type,message}}`（如 `overloaded_error`，对应非流式 HTTP 529） | 错误 JSON 后关闭流 | `type:"error"` 事件（含 `code/message/param`） |

规则：

- 源格式无对应语义的事件（anthropic 的 `thinking_delta`/`signature_delta`、responses 的 `reasoning_*` 与各类工具过程事件）丢弃并记 debug 日志；官方均声明**新事件类型可能增加，必须容忍未知事件**；
- `data: [DONE]` 是 openai 系流的传输层终止哨兵（OpenAI SDK 生态约定；官方 OpenAPI 规范只定义事件体、不覆盖 SSE 传输细节），不映射为语义事件；
- `input_json_delta.partial_json` 与 openai `tool_calls[].function.arguments` 增量同为 JSON 字符串片段，可累积拼接；anthropic 最终 `tool_use.input` 是**对象**，需在 `content_block_stop` 后整体 parse；
- SSE 帧格式：anthropic 同时携带 `event: <名>` 行与 `data` 内 `type` 字段；openai 系仅 `data:` 行——对外输出按目标格式约定生成。

## 11. 自动更新

`src/update/update-manager.ts`，流程：

1. `GET https://api.github.com/repos/{repo}/releases/latest`，semver 与当前版本比较；
2. 按 `{os}-{arch}` 选择 asset，下载到 `<binary>.new`；
3. SHA256 校验（校验值来自 Release 的 checksums 文件）；
4. 备份当前二进制 → `<binary>.backup`；
5. 原子替换为 `<binary>.new`；
6. `spawn <binary> --version` 自验证；`exitCode !== 0` → 从备份回滚；
7. 清理临时与备份文件。

**Windows 注意**：运行中的 exe 不能被覆盖或删除，但**可以重命名**。替换策略：`rename(current → current.old)` + `rename(new → current)`，重启后清理 `current.old`。

## 12. HTTP 端点契约

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | openai_chat 入口 |
| `POST /v1/responses` | openai_responses 入口 |
| `POST /v1/messages` | anthropic 入口 |
| `GET /v1/models` | 列出已配置模型（DC-2）。OpenAI 格式（默认）：`{object:"list", data:[{id, object:"model", created, owned_by}]}`；Anthropic 格式（请求带 `anthropic-version` 或 `x-api-key` 头）：`{data:[{id, type:"model", display_name, created_at, max_input_tokens, max_tokens, capabilities}], first_id, has_more, last_id}`——两种形状均已核实（§18） |
| `GET /health/keys` | Key 健康状态（掩码显示；配置 `auth_token` 后需鉴权） |
| `POST /admin/keys/:keyId/reset` | 重置指定 Key 健康状态 |

请求头约定：

| 头 | 作用 |
|---|---|
| `x-o2a2o-openai-key` | 动态传入 OpenAI Key |
| `x-o2a2o-anthropic-key` | 动态传入 Anthropic Key |
| `x-o2a2o-output-format` | 强制响应格式：`openai_chat` / `openai_responses` / `anthropic` |
| `Authorization` | 网关鉴权：配置 `server.auth_token` 后须带 `Bearer <token>`；该头不透传到上游 |
| `x-o2a2o-dropped`（响应头） | 列出本次请求被网关丢弃的不支持参数名（逗号分隔）；无丢弃时不输出 |

协议头核实结论：anthropic 格式端点按官方 SDK 行为要求 `anthropic-version: 2023-06-01` + `x-api-key` 头（该版本号至今仍是官方所有示例的现行值）；`x-api-key` 允许为占位值，真实上游 Key 按 §7 解析。openai 格式端点使用 `Authorization: Bearer`。

## 13. 项目结构

```
o2a2o/
├── src/
│   ├── index.ts                  # entry, bootstrap
│   ├── cli.ts                    # serve / config / convert / update / version
│   ├── server.ts                 # Bun.serve, routing, SSE response
│   ├── config/
│   │   ├── loader.ts             # YAML load + ${ENV} resolution
│   │   ├── validator.ts          # schema + semantic validation
│   │   └── template.ts           # config init template
│   ├── types/
│   │   ├── ir.ts                 # Intermediate Request/Response
│   │   ├── openai.ts             # openai_chat + openai_responses schemas
│   │   └── anthropic.ts          # anthropic messages schemas
│   ├── converters/
│   │   ├── chat-to-ir.ts / ir-to-chat.ts
│   │   ├── responses-to-ir.ts / ir-to-responses.ts
│   │   ├── anthropic-to-ir.ts / ir-to-anthropic.ts
│   │   └── stream-converter.ts   # SSE chunk mapping per (src, dst) pair
│   ├── core/
│   │   ├── format-detector.ts
│   │   ├── unified-converter.ts  # orchestration: detect -> route -> convert
│   │   ├── api-key-pool.ts
│   │   ├── smart-forwarder.ts
│   │   ├── timeout-calculator.ts
│   │   ├── stream-timeout-manager.ts
│   │   └── latency-optimizer.ts
│   ├── update/
│   │   ├── update-manager.ts
│   │   └── version-checker.ts
│   └── utils/
│       ├── logger.ts             # key masking enforced here
│       └── semver.ts
├── examples/
│   └── o2a2o.yaml
├── scripts/
│   ├── build.ts                  # bun build --compile per target
│   └── release.ts                # tag + GitHub Release + checksums upload
├── tests/
│   ├── converters/               # fixture-based round-trip tests
│   └── integration/
├── package.json
├── tsconfig.json
└── docs/
    ├── REQUIREMENTS.md
    └── TECH-DESIGN.md
```

## 14. 构建与发布

```bash
bun install
bun run dev                     # watch mode
bun test
bun run build:all               # dist/o2a2o-{darwin-arm64, darwin-x64,
                                #        linux-arm64, linux-x64, windows-x64.exe}
bun run release --version 1.0.0 # tag + GitHub Release + assets + checksums
```

## 15. 实现注意事项

1. **API schema 状态**：流式事件、stop_reason 枚举、错误结构、请求参数清单、`/v1/models` 形状已于 2026-09-21 对照官方文档逐项核实（来源清单见 §18）。文档核实不能替代对生产端点的行为验证——实现期仍须用真实 API 冒烟并录制 fixture 作为转换器契约测试；
2. **OpenAI 新参数**：注意 `max_completion_tokens` 等新参数与 `max_tokens` 的兼容处理；
3. **SSE 解析必须按行缓冲**：`data:` 负载可能跨 chunk 到达；
4. **剥离注入字段**：`o2a2o_keys` 必须在转发前从请求体移除；
5. **直通不等于裸代理**：直通路径同样经过 Key 池、超时管理与日志；
6. **并发安全**：Key 池状态被并发请求读写；单进程事件循环下注意避免 check-then-act 竞态；
7. **日志安全**：任何日志输出路径都不得出现明文 Key，掩码逻辑收敛在 logger 内实现；
8. **错误体格式**：返回给客户端的错误必须符合其请求协议的错误结构（openai `error.message/type/code`；anthropic `error.type/message`）。

## 16. 参数兼容策略（对应需求 DC-1 / DC-4）

下表参数名均已于 2026-09-21 对照官方请求参数清单核实（§18）：

| 参数（来源） | 处理 |
|---|---|
| `n > 1`（openai） | 400：`n` must be 1（目标 provider 不支持多候选） |
| `response_format: {type: "json_schema"}`（openai） | **可映射**（DC-4）→ anthropic `output_config.format`；目标模型不支持 structured outputs（查 `/v1/models` 的 `capabilities.structured_outputs`）时透传上游 400 并附网关说明 |
| `response_format: {type: "json_object"}`（openai，遗留 JSON mode） | 400：v1 不支持（DC-4），错误信息指引改用 `json_schema` |
| `presence_penalty` / `frequency_penalty` / `logit_bias`（openai） | 丢弃 + warn 日志 |
| `seed` / `logprobs` / `top_logprobs`（openai） | 丢弃 + warn 日志 |
| `reasoning_effort`（openai） | **可映射**（DC-7）→ anthropic `output_config.effort`：`none`/`minimal` → `low`，`low`/`medium`/`high`/`xhigh` 直传；模型不支持所映射档位时透传上游 400 |
| `verbosity`（openai） | 丢弃 + warn 日志 |
| `prediction` / `web_search_options`（openai） | 丢弃 + warn 日志 |
| `modalities` 含 `audio`（openai） | 400：目标 provider 不支持音频输出 |
| `stream_options.include_usage`（openai） | **保留语义**：转换后的流末尾附 `choices:[]` + `usage` chunk |
| `parallel_tool_calls: false`（openai） | **可映射**：转 anthropic `tool_choice.disable_parallel_tool_use: true`；`true` 时丢弃 |
| `stop`（openai，最多 4 个序列） | **可映射** → anthropic `stop_sequences` |
| `max_tokens`（openai，已 deprecated） | 同时接受 `max_tokens` 与 `max_completion_tokens`，统一进 IR `maxTokens` |
| `metadata`（anthropic `metadata.user_id`；openai 请求参数 `metadata`） | 丢弃 + debug 日志 |
| `cache_control`（anthropic 内容块） | 剥离 + debug 日志（v1 不做 OpenAI 自动缓存的映射） |
| `service_tier` / `store` / `safety_identifier` / `user`（openai） | 丢弃 + debug 日志 |

原则：**丢弃必须留痕（日志 + `x-o2a2o-dropped` 响应头），拒绝必须给原因**——不允许静默改变输出语义。

## 17. 测试策略

三层，全部离线可跑（不依赖真实 Key）：

1. **转换器契约测试（核心）**：每格式准备请求 / 响应 / 流式三组 fixture（JSON 文件），断言 `formatToIR → irToFormat` 与期望一致；fixture 首版手工构造，M2 前用真实 API 响应录制替换（录制时脱敏）；
2. **Round-trip 性质测试**：`openai_chat → IR → anthropic → IR → openai_chat` 语义字段无损（model / messages / tools / usage），允许字段增删但要求语义等值；
3. **核心组件单测**：ApiKeyPool（评分 / 冷却 / 恢复）、TimeoutCalculator（边界 clamp）、StreamTimeoutManager（假时钟）、UpdateManager（mock GitHub API + 临时目录，覆盖 Windows rename 替换分支）。

集成冒烟：`bun run dev` + 本地 mock 上游（record-replay 服务器），跑需求文档 §5 的 S1–S12。

## 18. 协议事实核实来源（2026-09-21 联网核实）

本文档中标注「已核实」的协议事实来自以下官方来源，抓取日期 2026-09-21：

**Anthropic**

- 流式事件与完整 SSE 响应示例（含 tool use / thinking / error 事件）：https://platform.claude.com/docs/en/build-with-claude/streaming
- 错误类型枚举与错误体结构（`{type:"error",error:{type,message},request_id}`）：https://platform.claude.com/docs/en/api/errors
- `GET /v1/models` 响应形状：https://platform.claude.com/docs/en/api/models-list
- `anthropic-version: 2023-06-01` 现行性、`x-api-key` 头、tool 定义（`input_schema`）、`tool_choice` 类型、`thinking:{type:"adaptive"}`：上述页面官方示例 + Anthropic SDK 技能参考（缓存 2026-06-24）
- structured outputs（`output_config.format`，取代已废弃的 `output_format`）与 `output_config.effort`（low/medium/high/xhigh/max，GA）：Anthropic SDK 技能参考（缓存 2026-06-24）；`capabilities.structured_outputs` / `capabilities.effort` 能力字段在 models-list 响应中实证（见上条来源）

**OpenAI**

- Chat Completions 全部请求参数与响应对象：https://platform.openai.com/docs/api-reference/chat/streaming （页面为 Chat Completions 分区）
- Chat 流式 chunk（`choices[].delta`、末 chunk 空 delta + `finish_reason`）：https://platform.openai.com/docs/guides/streaming
- chunk 对象与 `stream_options` 为请求体属性：官方 OpenAPI 规范仓库 openai/openai-openapi（经 zread 索引）
- Responses API 全部流式事件类型与负载：https://platform.openai.com/docs/api-reference/responses-streaming
- `GET /v1/models`（OpenAI 格式）：https://platform.openai.com/docs/api-reference/models/list
- 请求头（`Authorization: Bearer`、`x-request-id`、REST API 版本 `2020-10-01`）：https://platform.openai.com/docs/api-reference/overview

**注意**：`data: [DONE]` 终止哨兵未见于上述规范页面（OpenAPI 规范不覆盖 SSE 传输层），属 OpenAI SDK 生态的通行约定；实现时以 openai 官方 SDK 的实际解析行为为准。

## 19. M2 实现勘误（2026-09-21）

以实现与测试为准，对正文三处修正：

- **§8.1 公式优先级勘误**：实际实现为 `by_model > max_tokens 估算 > default`（by_model 是运维显式覆盖，压过通用估算；正文公式语序读作估算覆盖 by_model，以实现与测试为准）。
- **§8.2 空闲检测量化补偿**：空闲判定阈值为 `idle + grace + idle_check_interval`（采样间隔盲区补偿；Windows 定时器量化下朴素判定不稳定，实证 6/25 抖动）；默认配置下空闲中止约 70-80s。
- **§16** `parallel_tool_calls: true` 的丢弃记录与 `x-o2a2o-dropped` 头在流式路径同样生效；`responsesResponseToIr` 上游 `arguments` 解析失败已降级为 `input:{}` + warn（当前行为）。
- **§8** 首包计时自上游响应头到达后启动，头阶段由非流式超时约束。

## 20. M3 实现勘误（2026-09-22）

以实现与测试为准，对正文四处修正：

- **§9 故障转移流程（记账门控）**：流程句「失败则 `recordFailure`」读作任何失败都记账；实现为仅 **Key 级错误**（网络错误、超时、5xx、429、401/403，判定表 ✅ 行）累计 `recordFailure`，400/422 等请求级错误不记账、不降级 Key，直接返回客户端（非流式与流式首包窗口一致）。
- **§10 流式响应头时机**：SSE 响应头延迟到胜出 Key 的**首个上游字节**到达后才下发；headers 阶段（连接失败/非 2xx）的错误仍走 JSON 错误响应（M1 错误路径），不产生半开 SSE——重试窗口内对客户端零字节下发。
- **§8.2 空闲阈值**：无 §19 之外的补充（实现即 §19 修正后的 `idle + grace + idle_check_interval`）。
- **§7.3 keyId 与 reset 语义**：keyId = 掩码键（`maskKey(key)`），端点 URL 与记账均用掩码，明文 Key 不出池；`/admin/keys/:keyId/reset` 按模型配置顺序取**第一个**拥有该 keyId 的池（首匹配，未命中 404）；reset 归 healthy、清连败与冷却，保留延迟历史与累计失败数——reset 非 opt-out，Key 持续失败仍会在再满 `failure_threshold` 次后重新进入冷却。

## 21. M4 实现勘误（2026-09-22）

以实现与测试为准，对正文四处修正：

- **§11 更新源与拒绝粒度**：发现新版本不走 `/releases/latest`，而是拉取 release **列表**接口过滤（按 `allow_prerelease` 过滤 prerelease、仅取严格大于当前版本的 semver 最高者，`src/update/github-releases.ts`）；校验和为**强制项**——release 缺 `checksums.txt` 资产时结构性拒绝，不下载不替换（正文只写「SHA256 校验」，未写缺文件即拒）。`UpdateResult` 保持 `{ok, rolledBack}` 两字段不变、不携带原因：拒绝原因由 CLI 侧判别渲染——缺校验和资产可由 release 元数据直接识别，输出专门一行（"release has no checksums asset; refusing unverified install"）；其余失败一律输出通用一行（"new binary failed verification; current binary kept"），细节在日志。
- **§11 Windows 替换与清理时机**：替换序列实为 备份（复制 `.backup`）→ `rename(current → .old)` + `rename(.new → current)` → 自验证（`<binary> --version` 且输出须含新版本号）→ **同一进程内**清理 `.old`/`.backup`（自验证成功即清理，无需重启）；正文「重启后清理 current.old」以实现为准。`.old`/`.backup` 在恢复成功之前不得删除——替换中途死亡（binaryPath 缺失）时从尚存的恢复副本回滚。
- **§13/§14 发布改为 CI 构建**：§14「`bun run release` 本地 tag + 上传 assets + checksums」未实现；实际为 **tag 触发的 GitHub Actions**（`.github/workflows/release.yml`，push `v*` 即建预发布）：三平台 matrix **原生构建**（macos/ubuntu/windows，无交叉编译），逐平台打包原生安装器（Windows：zip + `install.ps1`；Linux：deb/rpm + 含 systemd unit 与 install.sh 的 tar.gz；macOS：含 launchd plist 的 tar.gz），合并为单一 `checksums.txt`（硬校验 14 行 = 5 二进制 + 9 安装器，资产名固定——更新器按该名获取）后 `gh release create --prerelease` 发布。本地 `scripts/release-rc.mjs`（即 §13 树中的 `scripts/release.ts`）只做门禁（测试绿/树净/tag 唯一）+ 打 tag + push；§13 树中 `src/update/version-checker.ts` 实际为 `src/update/github-releases.ts`。
- **§7.3 key 掩码公式**：`mask(key) = key.slice(0,8) + "..." + key.slice(-4)` 仅适用长度 > 12 的 key；≤8 全掩码为 `***`（对短 key 取 slice(-4) 会泄漏半数以上字符），9–12 字符输出 `***` + 末 4 位（M2 引入，正文与 §19/§20 均未记录，补记于此）。
- **Version scheme (version-true RC)**: the repo version IS the release version. During the RC period `package.json` itself carries the prerelease suffix (e.g. `0.3.0-rc.1`); the tag is exactly `v<version>` and installer asset names derive verbatim from it — nothing appends `-rc.1` anywhere (`scripts/release-rc.mjs`, `scripts/package-*.mjs`). With `allow_prerelease: true` an RC install keeps receiving `rc.N` releases and later the stable bump. The `version` command prints `o2a2o <semver>` (brand + version on one line) — the same channel the updater's self-verify (`<binary> --version` output must contain the new version) and the update identity guard rely on.

其余按正文执行，无进一步偏差。

## 22. live-test hardening 实现勘误（2026-09-23）

以实现与测试为准，对正文补记两处语义裁定：

- **§6.2 上游地址（每模型 `base_url`）**：`models[].base_url` 为可选字段，语义裁定为 **SDK 约定的完整前缀（含版本段）**——如智谱 `https://open.bigmodel.cn/api/paas/v4`；网关在其后追加方法路径（网关端点去掉前导 `/v1`，即 `/chat/completions` | `/responses` | `/messages`）。与 `O2A2O_UPSTREAM_*` 的裁定相反：env 与默认值仍是**纯 origin**（无版本段），其后追加完整网关端点（含 `/v1`）——`base_url` 缺省时 env/默认行为逐字节不变。优先级：`model.base_url` > `O2A2O_UPSTREAM_*` > provider 默认。校验在加载期执行（`ConfigError`，serve 与 `config validate` 同源生效）：必须为非空 http(s) URL、不得含 query/hash、去尾部斜杠；URL 构造收敛于 `resolveUpstreamUrl`（`src/core/forwarder.ts`），非流式与流式（建流）两条转发路径均经此透传。
- **§9/§10 客户端断连（live-test hardening Task 1，已合入）**：请求 signal 直通上游 fetch（`AbortSignal.any` 探测 + 手动回退）。断连是终态：不重试、不记 Key 账、无错误帧（非流式抛 AbortError；流式返回空且立即关闭的 SSE 流）。同一窗口内真实上游超时与客户端断连同时发生时，按断连处理（裁定维持）。
