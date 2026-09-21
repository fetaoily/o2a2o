# O2A2O 需求文档

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-21 |
| 状态 | 待实现 |
| 配套设计 | [TECH-DESIGN.md](./TECH-DESIGN.md) |

## 1. 项目概述

### 1.1 背景

OpenAI 与 Anthropic 是当前两大主流 LLM API 协议，但两者在请求/响应结构、流式事件、错误格式上互不兼容。典型痛点：

- 客户端/SDK 通常只支持其中一种协议（如 OpenAI 生态客户端无法直连 Claude）；
- 同时使用两家模型时，切换供应商需要改代码；
- 单个 API Key 存在限额与故障风险，需要多 Key 容错。

O2A2O 是一个本地运行的 API 网关：客户端按任意一种协议请求它，它自动转换为目标模型所属协议并转发，响应再转换回客户端的协议格式——客户端全程无感知。

### 1.2 目标

1. OpenAI ↔ Anthropic 双向协议转换，同时兼容 OpenAI 的两种对外接口（Chat Completions、Responses）；
2. 配置极简：只声明接入的模型，不配置转换规则；
3. 多 API Key 故障转移，优先使用可用且低延迟的 Key，降低端到端延迟；
4. 编译为独立可执行文件分发（单文件、免运行时），内置自动更新；
5. 架构为后续接入 Gemini 等新协议预留扩展点。

### 1.3 命名

**O2A2O** = OpenAI ↔ Anthropic ↔ OpenAI，直接表达双向转换语义。

## 2. 术语

| 术语 | 含义 |
|---|---|
| openai_chat | OpenAI Chat Completions 格式（`POST /v1/chat/completions`） |
| openai_responses | OpenAI Responses API 格式（`POST /v1/responses`） |
| anthropic | Anthropic Messages 格式（`POST /v1/messages`） |
| 直通（pass） | 请求格式所属 provider 与目标模型 provider 相同，不转换直接转发 |
| IR | Intermediate Representation，统一中间表示（见技术方案 §4） |
| 冷却（cooldown） | Key 连续失败后被暂停选用的时间窗口 |

## 3. 功能需求

优先级：P0 = 首版必须；P1 = 首版尽量；P2 = 后续版本。

### 3.1 三格式协议互转（P0）

网关对外暴露三种转换端点与一个模型列表端点；任意请求格式 × 任意已配置模型（含同协议直通），组合矩阵 3×3：

| 客户端请求端点 | 格式 | 可路由到 |
|---|---|---|
| `POST /v1/chat/completions` | openai_chat | 任意已配置模型 |
| `POST /v1/responses` | openai_responses | 任意已配置模型 |
| `POST /v1/messages` | anthropic | 任意已配置模型 |
| `GET /v1/models` | 双格式（见 FR-11） | 仅列出，不转发 |

具体需求：

- FR-1 请求体按目标模型 provider 的协议转换后转发；
- FR-2 响应体转回客户端请求时的格式返回；客户端可通过请求头 `x-o2a2o-output-format`（取值 `openai_chat` / `openai_responses` / `anthropic`）强制指定响应格式；
- FR-3 system 消息互转：OpenAI 的 `role: "system"` 消息 ↔ Anthropic 顶层 `system` 字段；
- FR-4 参数适配：`temperature` / `top_p` / `max_tokens` / `stop` 等；Anthropic `max_tokens` 必填，客户端未提供时使用默认值（建议 4096）；
- FR-5 Tool calling 互转：tools 定义（`parameters` ↔ `input_schema`）、调用块（`tool_calls` ↔ `tool_use`）、工具结果（`tool` 消息 ↔ `tool_result`）、终止原因（`finish_reason` ↔ `stop_reason`）双向映射；
- FR-6 usage 映射：`prompt_tokens` / `completion_tokens` / `total_tokens` ↔ `input_tokens` / `output_tokens`；
- FR-7 错误映射：HTTP 状态码与错误体结构转换为客户端协议的错误格式；
- FR-8 多模态：文本内容必须支持；图片等内容块按两侧协议能力映射，能力不对齐时返回明确错误；
- FR-9 参数兼容分级策略（逐参数表见技术方案 §16）：影响响应结构与数量的参数（`n > 1`、`response_format: json_object`）→ 400 明确报错；仅影响采样风格的参数（`presence_penalty`、`frequency_penalty`、`seed`、`logprobs` 等）→ 静默丢弃并记日志，同时通过响应头 `x-o2a2o-dropped` 回传本次被丢弃的参数名列表（无丢弃时不输出该头）；
- FR-10 结构化输出：`response_format: {type: "json_schema"}` **映射**到 Anthropic `output_config.format`；目标模型不支持时透传上游错误并附网关说明；遗留 JSON mode（`response_format: {type: "json_object"}`）v1 明确拒绝（400 + 原因说明，指引改用 `json_schema`）；
- FR-11 模型列表：`GET /v1/models` 返回已配置模型；默认 OpenAI 格式，请求携带 `anthropic-version` 或 `x-api-key` 头时返回 Anthropic 格式。

### 3.2 模型驱动路由（P0）

- 配置文件只声明接入模型（`name` + `provider`），**不配置**转换方向与路由规则；
- 请求格式由端点路径识别，辅以请求体特征推断；
- 目标模型由请求中的 `model` 字段决定（支持别名解析）；
- 同协议请求**直通**转发，不经转换（降低延迟、避免语义损耗）；
- 请求了未配置的模型 → 400，错误体符合请求方协议格式；
- 模型别名：`aliases` 提供短名 → 完整名映射，请求使用短名时先解析。

### 3.3 流式支持（P0）

- 客户端 `stream: true` 时，上游同样以流式调用，SSE 事件实时互转、逐块下发，不做整体缓冲；
- 三种格式的流式事件语义映射（开始 / 内容增量 / 工具调用增量 / 结束 / 错误）；
- `[DONE]` 等流结束标记按目标格式正确生成；
- 事件边界处理：SSE 事件可能被 TCP 分块切断，必须按行缓冲后再解析。

### 3.4 API Key 动态传入（P0）

Key 解析优先级（高 → 低）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 请求头 `x-o2a2o-openai-key` / `x-o2a2o-anthropic-key` | 按目标 provider 取对应 Key |
| 2 | 请求体字段 `o2a2o_keys.openai` / `o2a2o_keys.anthropic` | 转发前必须从请求体剥离 |
| 3 | 配置文件 `api_keys`（支持 `${ENV_VAR}` 引用） | 兜底 |

- 请求头/请求体动态传入的 Key 单次请求有效，直接使用，不纳入健康池统计（健康池只管理配置文件中的 Key）；
- Key 不落日志明文，一律掩码显示（如 `sk-abc1...x9z`）。

### 3.5 多 Key 故障转移（P0）

- 每个模型可配置多个 Key，带 `priority`（数字越小越优先）与 `weight`；
- 每次请求按评分选择最优 Key：优先级、权重、健康状态、近期平均延迟、连续失败次数；
- 失败自动换下一个 Key 重试（默认最多 3 次）；
- 可重试错误：网络错误、超时、5xx、429、流式首包超时；
- Key 级失败（401/403）：标记该 Key 失败并换 Key 重试——这是多 Key 池的核心价值；
- 请求级错误（400/422 等参数错误）：不重试，直接映射返回客户端；
- 冷却机制：Key 连续失败达阈值（默认 3 次）→ 进入冷却（默认 5 分钟），期间不选用；冷却结束后渐进恢复；
- 延迟统计：滚动窗口记录各 Key 最近请求延迟，评分时惩罚高延迟 Key。

### 3.6 超时管理（P0）

| 场景 | 策略 | 超时后 |
|---|---|---|
| 非流式 | 动态超时：按模型预设 + 按 `max_tokens` 估算 + 历史延迟自适应，夹在 [30s, 5min] | 换 Key 重试 |
| 流式 · 首包 | 30s 未收到首个数据块 | 换 Key 重试 |
| 流式 · 空闲 | 60s 无新数据（含 5s 宽限期） | 中断，已生成部分返回客户端，不重试 |
| 流式 · 总时长 | 10min 硬上限 | 强制终止 |

所有超时参数可在配置文件调整（见技术方案 §6、§8）。固定短超时**不得**截断长回复的非流式请求。

### 3.7 监控与管理端点（P1）

- `GET /health/keys`：全部配置 Key 的健康状态（Key 掩码显示：状态 / 连续失败 / 平均延迟 / 冷却剩余）；
- `POST /admin/keys/:keyId/reset`：手动重置指定 Key 的健康状态。

### 3.8 网关鉴权（P0）

- 可选 `server.auth_token`；配置后客户端请求须携带 `Authorization: Bearer <token>`（`/health/keys`、`/v1/models` 同样受保护）；
- 绑定非回环地址（非 `127.0.0.1` / `localhost`）且未配置 `auth_token` 时**拒绝启动**，报错提示二选一：改绑回环地址，或配置 token；
- 该鉴权仅保护网关自身，不改变 §3.4 的上游 Key 解析逻辑；`Authorization` 头不透传到上游。

### 3.9 自动更新（P1）

- 更新源：GitHub Releases；启动时异步检查新版本（可在配置关闭）；
- 发现新版本时提示用户；`o2a2o update` 手动触发更新；
- 更新流程：下载对应平台产物 → SHA256 校验 → 备份当前二进制 → 原子替换 → 运行 `--version` 自验证 → 验证失败自动回滚；
- 产物按 `{os}-{arch}` 命名，每版本五平台：darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 / windows-x64.exe。

### 3.10 后续扩展（P2）

- Gemini 协议接入：预期只需新增 Gemini ↔ IR 转换器与 provider 适配，不动核心；
- 多模型智能路由、请求缓存、用量统计（调用量 / Token 计量）。

## 4. CLI 命令

| 命令 | 说明 |
|---|---|
| `o2a2o serve [--config <path>] [--port <n>]` | 启动网关；默认读取 `./o2a2o.yaml` |
| `o2a2o config init` | 输出配置模板（可重定向到文件） |
| `o2a2o config validate <path>` | 校验配置文件 |
| `o2a2o config routes` | 打印当前模型 / 别名 / Key 池概览 |
| `o2a2o convert --input <file> [--to openai_chat\|openai_responses\|anthropic]` | 单次协议转换调试：自动识别输入格式；`--to` 缺省时转换为其对应协议（openai_chat ↔ anthropic） |
| `o2a2o update` | 检查并执行自更新 |
| `o2a2o version` | 打印版本与构建信息 |

## 5. 验收场景

配置含一个 openai 模型、一个 anthropic 模型及双方 Key（`$BASE` 为网关地址）。以下场景通过即视为核心功能达成：

```bash
# S1: openai_chat format -> anthropic model, response in openai_chat format
curl $BASE/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello"}]}'

# S2: openai_responses format -> anthropic model, response in responses format
curl $BASE/v1/responses -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","input":"Hello"}'

# S3: anthropic format -> openai model, response in anthropic format
curl $BASE/v1/messages -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# S4-S6: S1-S3 with "stream": true (SSE passthrough conversion)

# S7: set primary key invalid -> request still succeeds via backup key,
#     GET /health/keys shows primary key failing / entering cooldown

# S8: non-stream long reply (max_tokens=8192) -> not truncated by a fixed 30s timeout

# S9: same-protocol passthrough: openai_chat -> openai model behaves like a transparent proxy

# S10: GET /v1/models returns configured models (openai format;
#      anthropic format when request carries anthropic-version / x-api-key header)

# S11: bind 0.0.0.0 without server.auth_token -> startup refused with clear error;
#      with auth_token set, requests without "Authorization: Bearer <token>" get 401

# S12: response_format json_schema -> mapped to anthropic output_config.format,
#      response content is schema-valid JSON; response_format json_object -> 400
```

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 启动 < 100ms；转换引入延迟 < 5ms（不含上游网络）；空闲内存 < 50MB；并发 ≥ 1000 连接 |
| 平台 | Windows 10+ / macOS 11+ / Ubuntu 20.04+；x64 与 ARM64 |
| 协议版本 | OpenAI v1 API（Chat Completions + Responses）；Anthropic Messages `2023-06-01` |
| 安全 | Key 不硬编码、不写日志明文；网关鉴权（`auth_token`，见 3.8）；更新包 SHA256 校验；支持经 HTTPS 代理访问上游 |
| 可靠性 | 更新失败自动回滚；配置错误启动时明确报错（指明字段与原因） |

## 7. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | 配置加载 + 三格式非流式互转 + 模型路由 + 单 Key 转发 + `GET /v1/models` + 网关鉴权 | 2 周 |
| M2 | 流式 SSE 互转 + 超时管理（动态/三阶段） | 1 周 |
| M3 | 多 Key 池 + 故障转移 + 监控端点 | 1 周 |
| M4 | 自动更新 + 五平台构建发布 | 1 周 |
| M5 | Gemini 协议接入（可选） | 2 周 |

## 8. 设计决策（已确认）

以下 7 项原对话未覆盖，先按推荐默认值写入，**已于 2026-09-21 经项目所有者逐条确认**（其中 DC-4、DC-7 在联网核实协议现状后，由拒绝/丢弃改为映射）：

| # | 决策点 | 采用的默认值 | 备选 |
|---|---|---|---|
| DC-1 | 不支持参数的处理 | 分级：结构/数量性参数（`n>1`、`response_format`）报 400；风格性参数（penalties、`seed`、`logprobs`）丢弃+日志 | 全部静默丢弃 / 全部 400 |
| DC-2 | `GET /v1/models` | 提供；默认 OpenAI 格式，带 `anthropic-version`/`x-api-key` 头时返回 Anthropic 格式 | 仅 OpenAI 格式 / 不提供 |
| DC-3 | 网关鉴权 | 可选 `auth_token`；绑非回环地址且无 token 时拒绝启动 | 不做鉴权（仅限本机使用） |
| DC-4 | 结构化输出 / JSON mode | `json_schema` → **映射** Anthropic `output_config.format`（核实确认 Anthropic 已原生支持 structured outputs，模型能力以 `/v1/models` 的 `capabilities.structured_outputs` 为准）；`json_object`（遗留）v1 仍拒绝（400 + 指引） | 全部拒绝 / prompt 注入模拟 |
| DC-5 | anthropic `pause_turn` 终止原因（2026-09-21 核实新增） | 转为 openai `finish_reason:"stop"` 并记 warn；网关不自动续传 | 返回明确错误（客户端可感知被截断） |
| DC-6 | anthropic `refusal` ↔ openai `content_filter`（核实新增） | 近似互映射（语义不完全对等，但最接近） | 不映射，各自原样输出 |
| DC-7 | openai `reasoning_effort` / `verbosity`（核实新增） | `reasoning_effort` → **映射** anthropic `output_config.effort`（`none`/`minimal` → `low`，`low`/`medium`/`high`/`xhigh` 直传；两侧取值集已核实）；`verbosity` 丢弃 + warn | 两者均丢弃（成本/质量行为静默改变，不可取） |

## 9. 参考资源

- OpenAI API Reference: https://platform.openai.com/docs/api-reference
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages
- Bun 编译独立可执行文件: https://bun.com/docs/bundler/executables
- GitHub Releases API: https://docs.github.com/en/rest/releases
