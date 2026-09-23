# o2a2o 本地验证 / Smoke Test 手册

对真实上游（LLM API）验证网关全链路的标准流程。使用时机：发版前验收、改动转发/转换路径后、接入新上游时。2026-09-23 的四个实测发现（客户端断开崩溃、`/v1` 前缀不兼容、延迟记账、responses 入站对纯 chat 上游）均由本流程抓出。

全部命令为单行可直接粘贴。测试一律用免费/廉价模型的小请求（`max_tokens` ≤ 100）。

## 0. 前置：启动网关

本地配置 `o2a2o.local.yaml`（不入库；密钥走环境变量，磁盘无明文）：

```yaml
server:
  port: 18181
  host: "127.0.0.1"
  log_level: "info"
models:
  - name: "glm-4-flash"
    provider: "openai"
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    upstream_format: "chat"
    api_keys:
      - key: "${ZHIPU_KEY}"
        priority: 1
        weight: 100
aliases:
  "glm": "glm-4-flash"
```

启动（Key 从智谱控制台获取后导出为 `ZHIPU_KEY`）：

```bash
export PATH="$HOME/.bun/bin:$PATH"; export ZHIPU_KEY="<你的Key>"; bun run src/index.ts serve --config o2a2o.local.yaml
```

本机回环（127.0.0.1）无鉴权；若 `host` 改为非回环，必须在配置里设 `auth_token` 并在请求加 `Authorization: Bearer <token>`。

## 1. 直连上游 sanity（先隔离上游问题）

```bash
curl -sS -m 30 https://open.bigmodel.cn/api/paas/v4/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer $ZHIPU_KEY" -d '{"model":"glm-4-flash","messages":[{"role":"user","content":"reply with exactly: pong"}],"max_tokens":16}'
```

预期：200，`choices[0].message.content` = "pong"。失败则问题在上游/Key，与网关无关。

## 2. 三协议入站（POST）

| 端点 | 入站格式 | 上游路径 | 预期响应关键字段 |
|---|---|---|---|
| `/v1/chat/completions` | openai_chat | 同协议透传 | `object:"chat.completion"`、`choices[0].message.content`、`finish_reason:"stop"` |
| `/v1/responses` | openai_responses | IR→chat（需 `upstream_format:"chat"`） | `object:"response"`、`status:"completed"`、`output[].content[].type:"output_text"` |
| `/v1/messages` | anthropic | IR→chat | `type:"message"`、`content[].type:"text"`、`stop_reason:"end_turn"` |

```bash
curl -s http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"glm","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```
```bash
curl -s http://127.0.0.1:18181/v1/responses -H "Content-Type: application/json" -d '{"model":"glm-4-flash","max_output_tokens":64,"input":"一句话介绍你自己"}'
```
```bash
curl -s http://127.0.0.1:18181/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -d '{"model":"glm-4-flash","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

注意：`/v1/responses` 对"只会 chat"的上游必须配 `upstream_format: "chat"`，否则被同 provider 透传到上游 `/v1/responses`（没有该端点的上游返回 404）。

## 3. 流式（任意端点加 `"stream":true`）

```bash
curl -sN http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"glm","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"数到5"}]}'
```
```bash
curl -sN http://127.0.0.1:18181/v1/responses -H "Content-Type: application/json" -d '{"model":"glm-4-flash","stream":true,"max_output_tokens":64,"input":"数到5"}'
```
```bash
curl -sN http://127.0.0.1:18181/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -d '{"model":"glm-4-flash","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"数到5"}]}'
```

预期 SSE 事件语法（`grep -c "^data:"` 应 > 0）：

- chat：`data: {"object":"chat.completion.chunk",...,"choices":[{"delta":{...}}]}` 序列
- responses：`response.created` → `response.output_item.added` → `response.output_text.delta`×N →（`response.completed`）
- messages：`message_start` → `ping` → `content_block_start` → `content_block_delta`×N →（`message_stop`）

管道接 `head -c` 截断时 curl 报 23/56 属正常（读端提前关闭）。

## 4. 响应格式覆盖头（FR-2：任意入站 → 任意出站）

`x-o2a2o-output-format` 可选值：`openai_chat` | `openai_responses` | `anthropic`。

```bash
curl -s http://127.0.0.1:18181/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -H "x-o2a2o-output-format: openai_chat" -d '{"model":"glm-4-flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

预期：出站为 `chat.completion` 形态。入站参数有不被目标格式支持时，响应带 `x-o2a2o-dropped` 头列出丢弃项。

## 5. 监控端点（GET）

```bash
curl -s http://127.0.0.1:18181/v1/models
```
```bash
curl -s http://127.0.0.1:18181/health/keys
```

- `/v1/models`：带 `anthropic-version` 或 `x-api-key` 头时自动切换 anthropic 形态。
- `/health/keys`：`models.<name>.<maskedKeyId>.{status,consecutiveFailures,totalFailures,avgLatency,cooldownRemaining}`。**`avgLatency` 只统计网关进程内发过的请求**——刚重启时为 0 是预期（零样本），先发几个业务请求再查，成功后应非零。

## 6. 管理端点

```bash
curl -s -X POST http://127.0.0.1:18181/admin/keys/<maskedKeyId>/reset
```

`<maskedKeyId>` 从 `/health/keys` 输出复制（形如 `4cfdea45...QplB`）。预期：已知 id → 200 `{"reset":true,...}`；未知 id → 404。重置后该 Key 状态归 healthy、连败清零、冷却清除，下一个请求即可复用。

## 7. 错误路径

```bash
curl -s -w "\n%{http_code}\n" http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"不存在","messages":[{"role":"user","content":"x"}]}'
```
```bash
curl -s -w "\n%{http_code}\n" -X POST http://127.0.0.1:18181/admin/keys/0000...0000/reset
```

预期：未知模型 400（错误信封为入站格式，`type:"invalid_request_error"`）；未知 keyId 404。

## 8. 崩溃恢复探针（Bun 段错误回归，必做）

历史背景：Bun 1.3.7 在"客户端中断 SSE 流时网关仍向死套接字写"场景下原生段错误，两条并发流同时中止可确定性触发（bun.report/1.3.7/wr1ba42621gCghooC4kukvDglh6V8yxqe__g5govCA2DD）。修复后网关在客户端断开时立即取消上游。**CI 断言不了不崩，只能手动跑本探针。**

```bash
curl -sN -m 1 http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"glm-4-flash","stream":true,"max_tokens":300,"messages":[{"role":"user","content":"write a long story"}]}' >/dev/null 2>&1 & curl -sN -m 1 http://127.0.0.1:18181/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -d '{"model":"glm-4-flash","stream":true,"max_tokens":300,"messages":[{"role":"user","content":"write a long story"}]}' >/dev/null 2>&1 & wait; sleep 2; curl -s -m 5 http://127.0.0.1:18181/v1/models >/dev/null 2>&1 && echo SURVIVED || echo DEAD
```

预期：`SURVIVED`（两条流在 1 秒后被杀，网关继续服务）。输出 `DEAD` = 回归，立即停止发版。

## 9. 验收对照表

| # | 场景 | 预期 | 2026-09-23 实测 |
|---|---|---|---|
| 1 | 直连上游 sanity | 200 pong | ✅ |
| 2a | chat 入站（别名） | chat.completion | ✅ |
| 2b | responses 入站（upstream_format:chat） | response/output_text | ✅ |
| 2c | messages 入站 | message/end_turn | ✅ |
| 3 | 三格式流式 | 各格式 SSE 事件语法 | ✅ |
| 4 | x-o2a2o-output-format 覆盖 | 出站格式切换 + dropped 头 | ✅ |
| 5 | /v1/models + /health/keys | 双形态清单；请求后 avgLatency>0 | ✅（586.5ms） |
| 6 | admin reset | 200/404 | ✅ |
| 7 | 未知模型/keyId | 400/404 | ✅ |
| 8 | 双流中止探针 | SURVIVED | ✅ |
