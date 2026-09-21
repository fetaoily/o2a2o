# O2A2O M2 流式互转 + 动态超时实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 o2a2o v0.2：三格式 SSE 流式互转（验收 S4-S6）、非流式动态超时、三阶段流超时，并清偿 M1 移交的正确性 Backlog 子集。

**Architecture:** 源 SSE 字节流 → 行缓冲解析器（按源格式）→ 语义事件 `StreamEvent` → 目标格式编码器（累积状态：块序号/工具序号/累计 usage）→ 目标 SSE 字节流。同协议直通 = 透明字节管道（仅加超时监视）。非流式动态超时由 `TimeoutCalculator` 计算并注入 forwarder。流超时三阶段（首包/空闲/总时长）由 `StreamTimeoutManager` 监视上游 reader。

**Tech Stack:** 不变（Bun + TS strict，零新运行时依赖）。

**Spec:** `docs/REQUIREMENTS.md`（§3.3/§3.6、验收 S4-S6）+ `docs/TECH-DESIGN.md`（§8 超时、§10 已核实事件映射表——流式实现的事实来源）+ 计划尾部 M2 Carry-Forward Backlog。

## Global Constraints（沿 M1，增量如下）

- M1 全部约束继续有效（strict、无中文、公共契约字段名、Key 掩码、错误体格式、conventional commit 单行无 Co-Authored-By）
- 流式事件名/负载结构以 TECH-DESIGN §10 **已核实映射表**为准，不得自创；源格式无对应语义的事件丢弃并记 debug
- `data: [DONE]` 是 openai 系传输层终止哨兵；anthropic 流必须以 `message_stop` 事件结束
- 客户端非流式 → 上游非流式；客户端 `stream:true` → 上游 `stream:true`（1:1，不交叉）
- 流式中断（空闲/总时长超时）：已生成部分照常下发后关闭流，不换 Key 重试（spec D5）
- 动态超时夹在 `[timeout.non_stream.by_request.min, max]`（默认 30s–5min）；流超时参数全部来自配置 `timeout.stream.*`
- 测试用**真实短定时器**（配置短时长，如 100-300ms），不引入假时钟抽象（YAGNI ruling）
- openai_responses 编码器输出**最小可行事件集**（created / output_item.added / output_text.delta / output_item.done / completed / error）——中间事件（content_part.*、annotation 等）为增量语义，SDK 容忍缺失（ruling，记入报告）
- anthropic 编码器：`message_start.usage` 无法预知 input_tokens 时填 0 占位（SDK 从 `message_delta` 累计），上游为 anthropic 时透传真实值

## 文件结构（本计划增量）

```
src/
├── core/
│   ├── timeout-calculator.ts      # NEW 非流式动态超时 + LatencyTracker(滚动50)
│   ├── stream-timeout-manager.ts  # NEW 三阶段流超时(真实定时器)
│   ├── sse.ts                     # NEW 行缓冲SSE读写(跨chunk拼接、event/data解析、序列化)
│   └── stream-converter.ts        # NEW 语义事件枢纽: 解析器+编码器注册表、直通管道
├── converters/
│   ├── stream-chat.ts             # NEW openai_chat chunk 解析+编码
│   ├── stream-anthropic.ts        # NEW anthropic 事件 解析+编码
│   └── stream-responses.ts        # NEW responses 事件 解析+编码
├── config/loader.ts               # MOD +timeout 节 + 加载加固(Backlog)
├── config/template.ts             # MOD timeout 节启用, failover/update 注释掉
├── config/validator.ts            # MOD timeout 数值范围校验(Backlog)
├── core/forwarder.ts              # MOD timeout 参数化 + 空串Key穿透(Backlog)
├── core/unified-converter.ts      # MOD 拆出 handleGatewayStream
├── server.ts                      # MOD SSE 响应路径
├── utils/logger.ts                # MOD maskKey 短键防护(Backlog)
├── converters/errors.ts           # MOD 403→authentication(Backlog)
├── converters/chat.ts             # MOD 移除守卫→真实支持; tool_call缺function→ParamError
├── converters/responses.ts        # MOD 移除守卫; 上游arguments解析防护(Backlog)
├── converters/anthropic.ts        # MOD 移除守卫; URL图像sentinel修复(Backlog)
└── cli.ts                         # MOD --port 非法值警告(Backlog) + convert 命令
tests/ 对应新增 stream-*.test.ts、timeout-*.test.ts；integration 扩展 S4-S6
```

---

### Task 1: 配置 timeout 节 + 加载加固 + 模板更新

**Files:**
- Modify: `src/config/loader.ts`, `src/config/validator.ts`, `src/config/template.ts`
- Test: `tests/config/loader.test.ts`（追加）、`tests/config/validator.test.ts`（追加）

**Interfaces:**
- Produces:
```typescript
export interface TimeoutConfig {
  non_stream: { default: number; by_model: Record<string, number>;
    by_request: { ms_per_token: number; min: number; max: number } };
  stream: { first_packet: number; idle: number; idle_check_interval: number;
    idle_grace_period: number; total_max: number };
}
// AppConfig 增加可选字段: timeout?: TimeoutConfig
export function resolveTimeoutConfig(cfg: AppConfig): TimeoutConfig;  // 缺省补默认值(§6.1数值)
```
- Backlog 清偿（本任务一并）：loader 裸 catch 区分 ENOENT（"config file not found"）与其他错误（"cannot read config file: <reason>"）；空 YAML/非映射根 → ConfigError（"config file is empty or not a mapping"）；YAML 语法错误包装为 ConfigError（原 message 保留）；validator 补 `timeout` 数值范围校验（各值 > 0，min ≤ max，first_packet/idle/total_max 正数）。

- [ ] **Step 1: 写失败测试**（追加到两个测试文件）

loader 追加：
```typescript
test("timeout section loads with defaults when absent", async () => {
  const p = join(dir, "t1.yaml");
  writeFileSync(p, 'server: { port: 1, host: "127.0.0.1" }\nmodels: [{ name: "m", provider: "openai", api_keys: [{ key: "k", priority: 1 }] }]\n');
  const cfg = await loadConfig(p);
  const t = resolveTimeoutConfig(cfg);
  expect(t.non_stream.default).toBe(60000);
  expect(t.stream.first_packet).toBe(30000);
  expect(t.stream.total_max).toBe(600000);
});

test("timeout section loads explicit values", async () => {
  const p = join(dir, "t2.yaml");
  writeFileSync(p, 'timeout:\n  stream:\n    first_packet: 5000\n');
  const cfg = await loadConfig(p);
  expect(resolveTimeoutConfig(cfg).stream.first_packet).toBe(5000);
});

test("empty yaml file -> ConfigError, not TypeError", async () => {
  const p = join(dir, "t3.yaml");
  writeFileSync(p, "");
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("yaml syntax error -> ConfigError wrapping cause", async () => {
  const p = join(dir, "t4.yaml");
  writeFileSync(p, "models: [\n  broken");
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("unreadable file (bad path type) -> clear error, not 'not found'", async () => {
  // directory instead of file exercises the non-ENOENT read failure path
  await expect(loadConfig(dir)).rejects.toThrow(/cannot read config file/i);
});
```

validator 追加：
```typescript
test("negative timeout values rejected", () => {
  const c = base(); (c as any).timeout = { stream: { first_packet: -1 } };
  expect(validateConfig(c)[0]).toMatch(/timeout/);
});
test("non_stream min > max rejected", () => {
  const c = base(); (c as any).timeout = { non_stream: { by_request: { min: 100, max: 50 } } };
  expect(validateConfig(c)[0]).toMatch(/min.*max|max.*min/);
});
```

- [ ] **Step 2: RED** — `bun test tests/config/` 预期 FAIL（resolveTimeoutConfig 不存在等）
- [ ] **Step 3: 实现**——loader：读文件 catch 中 `if ((e as NodeJS.ErrnoException).code === "ENOENT")` 走原 not-found 分支，否则 throw ConfigError(`cannot read config file: ${path} (${e instanceof Error ? e.message : String(e)})`)；parse 外层 try/catch → ConfigError；parse 结果 `if (raw === null || raw === undefined) throw new ConfigError("config file is empty or not a mapping")`；新增 `resolveTimeoutConfig`（深合并默认值：`{non_stream:{default:60000,by_model:{},by_request:{ms_per_token:100,min:30000,max:300000}}, stream:{first_packet:30000,idle:60000,idle_check_interval:10000,idle_grace_period:5000,total_max:600000}}`，用户值逐键覆盖）。validator：timeout 递归校验数值为正数、min≤max。template.ts：`timeout:` 节从注释恢复为实际内容（§6.1 数值）；`failover:` 与 `update:` 节注释掉并加一行英文注释 "implemented in M3 / M4"。
- [ ] **Step 4: GREEN** — 全套件 + tsc
- [ ] **Step 5: Commit** `feat(config): timeout section, hardened loader, live template`

---

### Task 2: TimeoutCalculator + forwarder 参数化 + 杂项加固

**Files:**
- Create: `src/core/timeout-calculator.ts`
- Modify: `src/core/forwarder.ts`, `src/converters/errors.ts`, `src/utils/logger.ts`, `src/cli.ts`, `src/cli` serve 分支接 `setLogLevel`
- Test: `tests/core/timeout-calculator.test.ts`（新）、errors/logger/forwarder/cli 测试追加

**Interfaces:**
- Produces:
```typescript
export class LatencyTracker {
  record(model: string, latencyMs: number): void;      // 滚动窗口50
  avg(model: string): number;                           // 无数据返回0
}
export const latencyTracker: LatencyTracker;            // 进程级单例
export function calculateTimeout(opts: { model: string; maxTokens: number;
  isStream: boolean; tc: TimeoutConfig }): number;
// 公式(spec §8.1): base = by_model[model] ?? default
//   !isStream && maxTokens: clamp(maxTokens*ms_per_token, min, max)
//   timeout = max(timeout, avgLatency(model)*3)  — clamp 后仍受 max 上限约束
```
- Backlog 清偿：errors.ts 两条分类表 `upstream === 401 || upstream === 403` → authentication（+双向测试各一）；logger maskKey 短键防护（`key.length <= 12` → `"***" + key.slice(-4)`，+测试）；forwarder resolveKey 空串 Key 视为未提供（`hdrKey || bodyKey || ...` 改为 truthy 过滤，+测试 `x-o2a2o-openai-key: ""` 落到 config Key）；cli `--port` 非数字时 stderr 一行警告后忽略（+测试 parseArgv 不变，警告在 runCli）；serve 启动时 `setLogLevel(cfg.server.log_level)`（logger.ts 补 `export function setLogLevel(level: string): void`，warn/error 恒输出，log 受 info 门控）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/timeout-calculator.test.ts
import { test, expect } from "bun:test";
import { calculateTimeout, LatencyTracker } from "../../src/timeout-calculator";
import { resolveTimeoutConfig } from "../../src/config/loader";
import type { AppConfig } from "../../src/config/loader";

const tc = resolveTimeoutConfig({ server: { port: 0, host: "127.0.0.1" }, models: [], aliases: {}, api_keys: {} } as AppConfig);

test("default timeout when nothing special", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100, isStream: false, tc })).toBe(30000));  // 100*100=10s < min 30s

test("max_tokens estimation clamps to max", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100000, isStream: false, tc })).toBe(300000));

test("by_model overrides estimation", () => {
  const t2 = { ...tc, non_stream: { ...tc.non_stream, by_model: { big: 120000 } } };
  expect(calculateTimeout({ model: "big", maxTokens: 10, isStream: false, tc: t2 })).toBe(120000);
});

test("stream skips token estimation (min floor still applies)", () =>
  expect(calculateTimeout({ model: "m", maxTokens: 100000, isStream: true, tc })).toBe(60000)); // default

test("adaptive: 3x avg latency raises floor", () => {
  const lt = new LatencyTracker();
  for (let i = 0; i < 5; i++) lt.record("slow", 20000);   // avg 20s -> 60s
  expect(calculateTimeout({ model: "slow", maxTokens: 100, isStream: true, tc, tracker: lt })).toBe(60000);
});
```
（签名含可选 `tracker?: LatencyTracker` 参数，缺省用进程级单例。）

errors/logger/forwarder/cli 追加测试：
```typescript
// errors.test.ts
test("upstream 403 classifies as authentication toward anthropic client", () => {
  const r = toClientError(502, { upstream: 403, body: { error: { message: "forbidden", type: "insufficient_quota" } } }, "anthropic");
  expect((r.body as any).error.type).toBe("authentication_error");
});
// logger 追加
test("maskKey guards short keys", () => {
  expect(maskKey("short1key")).toBe("***" + "t1key");  // 9 chars
  expect(maskKey("sk-averylongapikey-value")).toBe("sk-avery" + "..." + "alue");
});
// forwarder.test.ts 追加
test("empty-string header key falls through to config key", () => {
  const { key } = resolveKey(cfgBase, { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-real", priority: 1 }] }, { "x-o2a2o-openai-key": "" }, {});
  expect(key).toBe("sk-real");
});
// cli.test.ts 追加（runCli 层面不可单测 stdout——改为导出纯函数）
test("parsePort warns and ignores non-numeric", () => {
  expect(parsePort("abc")).toBeUndefined();
  expect(parsePort("9090")).toBe(9090);
});
```

- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**（公式与守卫如上；`parsePort` 从 runCli 内联逻辑提取导出）
- [ ] **Step 4: GREEN**
- [ ] **Step 5: Commit** `feat(core): dynamic non-stream timeout and hardening batch`

---

### Task 3: SSE 读写层 + openai_chat 流解析/编码

**Files:**
- Create: `src/core/sse.ts`, `src/converters/stream-chat.ts`
- Test: `tests/core/sse.test.ts`, `tests/converters/stream-chat.test.ts`

**Interfaces:**
- Produces:
```typescript
// src/core/sse.ts
export class SseLineReader {
  push(chunkText: string): { event?: string; data: string }[];  // 跨chunk缓冲,返回完整帧
}
export function encodeSse(data: string, event?: string): string; // "event: x\ndata: y\n\n" | "data: y\n\n"

// src/converters/stream-chat.ts
export type StreamEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; partialJson: string }
  | { type: "end"; stopReason: "stop" | "length" | "tool_use" | "content_filter"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string };
export function parseChatChunk(data: string): StreamEvent[];   // 空data/[DONE]→[]  [DONE]由调用层处理
export function isDoneSentinel(data: string): boolean;          // data === "[DONE]"
export class ChatStreamEncoder {                                // 状态: 首chunk已发? 工具index
  push(ev: StreamEvent): string;   // 返回该事件对应的SSE文本(可能多帧,可能空串)
  finish(usage?: { inputTokens: number; outputTokens: number }): string; // finish_reason帧+[DONE]
}
```
- 事实依据：TECH-DESIGN §10 已核实表（首chunk role delta / delta.content / delta.tool_calls{index,id,function:{name,arguments}} / 空 delta+finish_reason 末 chunk / include_usage 时 choices:[] usage chunk / [DONE]）。

- [ ] **Step 1: 写失败测试**（关键用例）

```typescript
// sse.test.ts
test("frames split across chunks reassemble", () => {
  const r = new SseLineReader();
  expect(r.push('data: {"a"')).toEqual([]);
  expect(r.push(':1}\n\ndata: [DONE]\n\n')).toEqual([{ data: '{"a":1}' }, { data: "[DONE]" }]);
});
test("event line captured", () => {
  const r = new SseLineReader();
  expect(r.push('event: message_start\ndata: {"type":"message_start"}\n\n'))
    .toEqual([{ event: "message_start", data: '{"type":"message_start"}' }]);
});
// stream-chat.test.ts
test("parseChatChunk: role-only first chunk -> start, content delta -> text_delta", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}'))
    .toEqual([{ type: "start" }]);
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"content":"He"}}]}'))
    .toEqual([{ type: "text_delta", text: "He" }]);
});
test("parseChatChunk: tool_call start + arguments delta", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":""}}]}}]}'))
    .toEqual([{ type: "tool_start", index: 0, id: "c1", name: "f" }]);
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\""}}]}}]}'))
    .toEqual([{ type: "tool_delta", index: 0, partialJson: '{"a"' }]);
});
test("parseChatChunk: finish_reason and usage chunk", () => {
  expect(parseChatChunk('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'))
    .toEqual([{ type: "end", stopReason: "stop" }]);
  expect(parseChatChunk('{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }]);
});
test("encoder produces role chunk, deltas, finish, DONE", () => {
  const e = new ChatStreamEncoder();
  const out = [e.push({ type: "start" }), e.push({ type: "text_delta", text: "Hi" }),
    e.finish({ inputTokens: 3, outputTokens: 1 })].join("");
  expect(out).toContain('"role":"assistant"');
  expect(out).toContain('"content":"Hi"');
  expect(out).toContain('"finish_reason":"stop"');
  expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
});
test("finish_reason maps stop_reason table", () => {
  const e = new ChatStreamEncoder();
  expect(e.push({ type: "end", stopReason: "tool_use" })).toContain('"tool_calls"');
});
```

- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**——SseLineReader：按 `\n` 分割、跨 chunk 保留尾行、空行=帧边界、`event:`/`data:` 前缀剥离、忽略注释行。parseChatChunk：`JSON.parse` 防护（坏 chunk → console.warn + []）；finish_reason 映射表（stop→stop, length→length, tool_calls→tool_use, content_filter→content_filter）。ChatStreamEncoder：finish 帧拼 usage（若调用方给了 usage 或 end 事件带 usage）。**finish_reason 帧与 usage 帧合一**（openai 实际行为：usage chunk choices:[] 单独，简化为 finish chunk 内嵌 usage + 另发一个 choices:[] usage 帧——按 §10 保守双帧）。
- [ ] **Step 4: GREEN**
- [ ] **Step 5: Commit** `feat(stream): sse framing and openai_chat stream codec`

---

### Task 4: anthropic 流解析/编码

**Files:**
- Create: `src/converters/stream-anthropic.ts`
- Test: `tests/converters/stream-anthropic.test.ts`

**Interfaces:**
- Produces:
```typescript
export function parseAnthropicEvent(event: string | undefined, data: string): StreamEvent[];
// message_start→start(带真实usage则附); content_block_start(tool_use)→tool_start;
// content_block_delta(text_delta/input_json_delta)→text_delta/tool_delta;
// message_delta(delta.stop_reason + usage.output_tokens 累计)→end;
// message_stop→[]; ping→[]; error→error事件
export class AnthropicStreamEncoder {   // 状态: blockIndex, 当前块类型, 累计output_tokens
  start(inputTokens?: number): string;  // message_start(+content_block_start text)
  push(ev: StreamEvent): string;
  finish(): string;                     // message_delta(stop_reason)+message_stop
}
```
- 事实依据：§10 表（`message_start` 含 message 对象；`content_block_start{index,content_block:{type:"tool_use",id,name,input:{}}}`；`text_delta{text}`；`input_json_delta{partial_json}`；`message_delta{delta:{stop_reason},usage:{output_tokens}}` 累计；`message_stop`；`ping` 丢弃；`event: error` 帧）。

- [ ] **Step 1: 写失败测试**

```typescript
test("parseAnthropicEvent full sequence", () => {
  expect(parseAnthropicEvent("message_start", '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}'))
    .toEqual([{ type: "start" }]);
  expect(parseAnthropicEvent("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'))
    .toEqual([{ type: "text_delta", text: "Hello" }]);
  expect(parseAnthropicEvent("content_block_start", '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}'))
    .toEqual([{ type: "tool_start", index: 1, id: "t1", name: "f" }]);
  expect(parseAnthropicEvent("content_block_delta", '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\""}}'))
    .toEqual([{ type: "tool_delta", index: 1, partialJson: '{"x"' }]);
  expect(parseAnthropicEvent("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 25, outputTokens: 15 } }]);
  expect(parseAnthropicEvent("ping", '{"type":"ping"}')).toEqual([]);
  expect(parseAnthropicEvent("error", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))
    .toEqual([{ type: "error", message: "Overloaded" }]);
});
test("encoder emits anthropic wire frames incl message_stop terminator", () => {
  const e = new AnthropicStreamEncoder();
  const out = e.start(25) + e.push({ type: "text_delta", text: "Hi" })
    + e.push({ type: "end", stopReason: "stop", usage: { inputTokens: 25, outputTokens: 3 } }) + e.finish();
  expect(out).toContain("event: message_start");
  expect(out).toContain('"type":"text_delta","text":"Hi"');
  expect(out).toContain('"stop_reason":"end_turn"');
  expect(out).toContain("event: message_stop");
});
test("encoder tool_use path emits content_block_start/stop with input_json_delta", () => {
  const e = new AnthropicStreamEncoder();
  const out = e.start() + e.push({ type: "tool_start", index: 1, id: "t1", name: "f" })
    + e.push({ type: "tool_delta", index: 1, partialJson: '{"x":1}' }) + e.finish();
  expect(out).toContain('"type":"tool_use","id":"t1","name":"f"');
  expect(out).toContain("input_json_delta");
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（stop_reason 表复用 anthropic.ts 已有映射常量——提取导出复用，勿复制；encoder 在 message_delta 前补发未关闭块的 content_block_stop）→ **Step 4: GREEN** → **Step 5: Commit** `feat(stream): anthropic stream codec`

---

### Task 5: responses 流解析/编码（最小可行事件集 ruling）

**Files:**
- Create: `src/converters/stream-responses.ts`
- Test: `tests/converters/stream-responses.test.ts`

**Interfaces:**
- Produces:
```typescript
export function parseResponsesEvent(data: string): StreamEvent[];
// type:response.output_text.delta→text_delta(delta); function_call_arguments.delta→tool_delta;
// response.output_item.added(function_call)→tool_start(call_id,name);
// response.completed→end(+usage); response.failed/incomplete→end(length|content_filter);
// type:"error"→error事件; 其余(created/in_progress/output_item.added(message)等)→[]
export class ResponsesStreamEncoder {   // 最小事件集: created/output_item.added/output_text.delta/output_item.done/response.completed
  start(): string;
  push(ev: StreamEvent): string;
  finish(stopReason, usage?): string;   // response.completed含usage
}
```

- [ ] **Step 1: 写失败测试**

```typescript
test("parseResponsesEvent maps verified event names", () => {
  expect(parseResponsesEvent('{"type":"response.output_text.delta","delta":"He"}'))
    .toEqual([{ type: "text_delta", text: "He" }]);
  expect(parseResponsesEvent('{"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"f","arguments":""}}'))
    .toEqual([{ type: "tool_start", index: 0, id: "c1", name: "f" }]);
  expect(parseResponsesEvent('{"type":"response.function_call_arguments.delta","delta":"{\\"a\\""}'))
    .toEqual([{ type: "tool_delta", index: 0, partialJson: '{"a"' }]);
  expect(parseResponsesEvent('{"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}'))
    .toEqual([{ type: "end", stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }]);
  expect(parseResponsesEvent('{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}'))
    .toEqual([{ type: "end", stopReason: "length" }]);
  expect(parseResponsesEvent('{"type":"response.created","response":{}}')).toEqual([]);
});
test("encoder emits minimal viable event set", () => {
  const e = new ResponsesStreamEncoder();
  const out = e.start() + e.push({ type: "text_delta", text: "Hi" })
    + e.finish("stop", { inputTokens: 3, outputTokens: 2 });
  expect(out).toContain('"type":"response.created"');
  expect(out).toContain('"type":"response.output_text.delta","item_id"');
  expect(out).toContain('"type":"response.completed"');
  expect(out).toContain('"total_tokens":5');
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（编码器维护 item_id/计数器，tool 事件发 `function_call` item + `response.function_call_arguments.delta`）→ **Step 4: GREEN** → **Step 5: Commit** `feat(stream): openai_responses stream codec`

---

### Task 6: StreamTimeoutManager + 直通管道

**Files:**
- Create: `src/core/stream-timeout-manager.ts`, `src/core/stream-converter.ts`
- Test: `tests/core/stream-timeout-manager.test.ts`, `tests/core/stream-converter.test.ts`

**Interfaces:**
- Produces:
```typescript
// stream-timeout-manager.ts — 真实定时器,测试用短配置值
export class StreamTimeoutManager {
  constructor(cfg: TimeoutConfig["stream"]) {}
  arm(onFirstByte: () => void): void;          // 启动首包/空闲/总时长三组定时器
  noteData(): void;                            // 每次收到上游数据调用
  disarm(): void;                              // finally 清理
}
export class StreamTimeoutError extends Error { stage: "first_packet" | "idle" | "total"; retryable: boolean }
// first_packet 超时 → retryable=true; idle/total → retryable=false(客户端收到已生成部分)
// stream-converter.ts
export function pipeThrough(src: ReadableStream<Uint8Array>, monitor: StreamTimeoutManager): ReadableStream<Uint8Array>;
// 同协议直通: 字节透传 + noteData 监视; 无解析无转换
export function convertStream(opts: {
  srcFormat: InputFormat; dstFormat: InputFormat;
  source: ReadableStream<Uint8Array>; monitor: StreamTimeoutManager;
  usageSink?: (u: { inputTokens: number; outputTokens: number }) => void;
}): ReadableStream<Uint8Array>;
// src → TextDecoder → SseLineReader → parseXxx → StreamEvent[] → dst Encoder → enqueue
// 直通格式相同但需解析(如收集usage)时也走此路径? 不——同格式一律 pipeThrough
```

- [ ] **Step 1: 写失败测试**

```typescript
// stream-timeout-manager.test.ts — 短配置: first_packet=100, idle=150, check=50, grace=10, total=1000
test("first packet cancels first-packet timer", async () => {
  const m = new StreamTimeoutManager({ first_packet: 100, idle: 150, idle_check_interval: 50, idle_grace_period: 10, total_max: 1000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });  // 签名裁定: arm(onTimeout) 由 manager 判阶段
  m.noteData();                                       // 首包到达
  await new Promise(r => setTimeout(r, 200));
  expect(err).toBeUndefined();
  m.disarm();
});
test("no first packet fires retryable first_packet error", async () => {
  const m = new StreamTimeoutManager({ first_packet: 80, idle: 150, idle_check_interval: 50, idle_grace_period: 10, total_max: 1000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });
  await new Promise(r => setTimeout(r, 150));
  expect(err?.stage).toBe("first_packet");
  expect(err?.retryable).toBe(true);
  m.disarm();
});
test("stalled stream fires idle error after grace", async () => {
  const m = new StreamTimeoutManager({ first_packet: 80, idle: 120, idle_check_interval: 40, idle_grace_period: 20, total_max: 5000 });
  let err: StreamTimeoutError | undefined;
  m.arm((e) => { err = e as StreamTimeoutError; });
  m.noteData();                    // 首包
  await new Promise(r => setTimeout(r, 250));  // 无后续数据
  expect(err?.stage).toBe("idle");
  expect(err?.retryable).toBe(false);
  m.disarm();
});
// stream-converter.test.ts
test("pipeThrough passes bytes and notes data", async () => {
  const src = streamOf([enc("data: {\"a\":1}\n\n"), enc("data: [DONE]\n\n")]);
  let bytes = 0; const monitor = fakeMonitor(() => bytes++);
  const out = pipeThrough(src, monitor);
  const text = await readAll(out);
  expect(text).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  expect(bytes).toBe(2);
});
test("convertStream anthropic->chat end to end", async () => {
  const frames = enc('event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":4,"output_tokens":1}}}\n\n')
    + enc('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n')
    + enc('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n')
    + enc('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  let usage: any;
  const out = convertStream({ srcFormat: "anthropic", dstFormat: "openai_chat", source: streamOf([frames]), monitor: fakeMonitor(), usageSink: (u) => (usage = u) });
  const text = await readAll(out);
  expect(text).toContain('"content":"Hi"');
  expect(text).toContain('"finish_reason":"stop"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  expect(usage).toEqual({ inputTokens: 4, outputTokens: 3 });
});
```
（`fakeMonitor`/`streamOf`/`readAll` 为测试文件内 8 行辅助函数，计划给出意图，实现照写。）

- [ ] **Step 2: RED** → **Step 3: 实现**（manager 定时器组：首包一次性 / 空闲周期检查 now-lastData / 总时长一次性；`arm(onTimeout)` 统一回调由 manager 判 stage——修正测试签名注释；convertStream 用 `getReader()` 循环 + `TextDecoder({stream:true})` + 编码器实例 + `usageSink` 回传）→ **Step 4: GREEN** → **Step 5: Commit** `feat(stream): timeout manager, passthrough pipe, conversion hub`

---

### Task 7: 网关流式主路径 + 服务端 SSE 输出（S4-S6）

**Files:**
- Modify: `src/core/unified-converter.ts`（新增 `handleGatewayStream`，移除 4 处 M1 stream 守卫）、`src/server.ts`（SSE 响应分支）、`src/converters/{chat,responses,anthropic}.ts`（删守卫；stream 字段照常映射）
- Test: `tests/integration/gateway.test.ts`（追加 S4/S5/S6 + 超时中断用例）

**Interfaces:**
- Produces:
```typescript
export async function handleGatewayStream(cfg: AppConfig, path: string, body: Record<string, unknown>, headers: Record<string, string | undefined>):
  Promise<{ status: number; stream: ReadableStream<Uint8Array>; contentType: "text/event-stream"; droppedParams?: string[] } | GatewayOutcome>;
// 复用 M1 前半程(detect/alias/model/resolveKey/请求转换) — 提取共享函数避免复制
// 上游响应: body 必须 stream:true 且 headers Accept SSE; 返回 Response.body
// srcFormat === dstFormat(同协议同格式) → pipeThrough; 否则 convertStream
// stream 检测真值化(Backlog): body.stream === true || "true" || 1 → 走流式
```
- server.ts：POST 分支若流式 → `new Response(result.stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })`；流中错误（上游非 2xx 仍走 M1 错误路径——流式错误只发生在流建立后：TimeoutError → 编码目标格式 error 帧 + 关流）。
- 跨格式流式映射真值表：anthropic 上游 ↔ openai_chat/openai_responses 客户端（双向）、openai_chat 上游 ↔ anthropic/responses 客户端、openai_responses 上游 ↔ anthropic/chat 客户端——全部经 StreamEvent 枢纽（解析器×编码器 3×3 减 3 个同格式直通）。

- [ ] **Step 1: 写失败集成测试**（mock SSE 上游，追加到 gateway.test.ts）

```typescript
// anthropicUp 增加 stream:true 分支: 返回 SSE 响应(message_start/text_delta/message_delta/message_stop)
test("S4: openai_chat stream client -> anthropic model streams chat chunks", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], stream: true });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const text = await res.text();
  expect(text).toContain('"role":"assistant"');
  expect(text).toContain('"content":"stream-hello"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
});
// anthropicUp 的 stream 分支返回 text_delta("stream-hello")
test("S5: openai_responses stream client -> anthropic model", async () => {
  const res = await post("/v1/responses", { model: "claude-sonnet-4-5", input: "hi", stream: true });
  const text = await res.text();
  expect(text).toContain('"type":"response.output_text.delta"');
  expect(text).toContain("stream-hello");
  expect(text).toContain('"type":"response.completed"');
});
// openaiUp 增加 stream:true 分支(chunk role/content/[DONE]); openaiSeenStream 捕获 body
test("S6: anthropic stream client -> openai model emits message_stop", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }], stream: true },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain('"stop_reason":"stop"');
  expect(text).toContain("event: message_stop");
});
test("passthrough stream: openai_chat -> openai model pipes bytes verbatim", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true });
  const text = await res.text();
  expect(text).toBe(openaiSseFixture);   // 与 mock 上游发出的字节完全一致(直通)
});
test("stream:true to a stream-incapable upstream still surfaces first-byte", async () => {
  // 慢 mock: 上游 500ms 后才发首帧, gateway stream.first_packet 配 100ms → 客户端收到 error 帧后关流
});
```
（新增网关实例 `streamGw` 用短超时配置；现有 gw 配置不变。）

- [ ] **Step 2: RED** → **Step 3: 实现**（共享前半程提取 `resolveRoute` 私有函数；M1 四处守卫删除——`stream` 字段现在正常进 IR/透传；非流式路径行为不变，回归靠现有 80 测试）→ **Step 4: GREEN（80 旧 + 新全部）** → **Step 5: Commit** `feat(gateway): streaming conversion path with sse output`

---

### Task 8: 剩余 Backlog 正确性批（一次清偿）

**Files:**
- Modify: `src/converters/chat.ts`（tool_call 缺 `function` → ParamError）、`src/converters/responses.ts`（上游 `arguments` 解析防护——degrade `input:{}`+warn，同 chat 响应侧）、`src/converters/anthropic.ts`（URL 图像：目标为 anthropic 的出向 `mediaType:"url"` image part → warn + 跳过 + dropped 记 `image_url`，不再发 `{source:{type:"base64",media_type:"url"}}` sentinel——需要 irToAnthropic 感知 dropped；实现为返回值扩展或抛专用可收集警告，实现者按现有结构选择并在报告说明）
- Test: 三个转换器测试文件追加

```typescript
// chat.test.ts
test("tool_call missing function -> ParamError", () => {
  expect(() => chatToIr({ model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function" }] }] })).toThrow(ParamError);
});
// responses.test.ts
test("malformed upstream arguments degrade instead of throwing", () => {
  const ir = responsesResponseToIr({ id: "r", model: "m", status: "completed",
    output: [{ id: "fc", type: "function_call", call_id: "c1", name: "f", arguments: "{bad" }], usage: { input_tokens: 1, output_tokens: 1 } });
  expect((ir.content[0] as any).input).toEqual({});
});
// anthropic.test.ts
test("url-source image to anthropic is skipped and recorded", () => {
  const out = irToAnthropic({ model: "m", messages: [{ role: "user", content: [
    { type: "image", mediaType: "url", data: "https://x/img.png" } as any] }], maxTokens: 10, stream: false });
  expect(out.messages[0].content).toEqual([]);   // 或不含 image 块的断言,按实现
});
```

- [ ] **Step 1: RED**（三测试失败）→ **Step 2: 实现** → **Step 3: GREEN 全套件** → **Step 4: Commit** `fix(converters): backlog correctness batch`

---

### Task 9: `o2a2o convert` 命令（M1 移交项）

**Files:**
- Modify: `src/cli.ts`（新增 convert 子命令 + help 文本）
- Test: `tests/cli.test.ts` 追加

**Interfaces:**
- Produces:
```typescript
// parseArgv 增加分支: { cmd: "convert"; inputPath: string; to?: InputFormat }
// runCli: 读文件 -> JSON.parse(失败 exit 1) -> detectFormat("<stdin>", body) 判源格式
//   -> to 缺省时取对应协议(openai_chat↔anthropic, openai_responses→anthropic, anthropic→openai_chat)
//   -> 请求转换(formatToIr -> irToFormat) -> 打印 JSON(2空格缩进)
```

- [ ] **Step 1: 失败测试**

```typescript
test("convert parses args", () => {
  expect(parseArgv(["convert", "--input", "r.json"])).toEqual({ cmd: "convert", inputPath: "r.json", to: undefined });
  expect(parseArgv(["convert", "--input", "r.json", "--to", "anthropic"])).toEqual({ cmd: "convert", inputPath: "r.json", to: "anthropic" });
});
```
（convert 执行逻辑以手动冒烟为准：写一个 chat 请求 JSON，`convert --input` 输出 anthropic 形状。）

- [ ] **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN + 手动冒烟** → **Step 5: Commit** `feat(cli): convert subcommand for offline protocol debugging`

---

### Task 10: 文档收尾

**Files:**
- Modify: `README.md`（M2 scope 更新：流式支持✓、动态超时✓、S4-S6 示例；仍缺：多 Key 池 M3、自动更新 M4）、`docs/superpowers/plans/2026-09-21-m2-streaming-timeouts.md` 尾部追加本计划执行勘误节（模板同 M1）
- Test: 无（文档任务）

- [ ] **Step 1: 全套件 + tsc 最终验证** → **Step 2: README 更新**（英文）→ **Step 3: Commit** `docs: update readme for m2 streaming and timeouts`

---

## Self-Review 记录

- **Spec 覆盖（M2 范围）**：FR-2 流式（Task 3-7，含 x-o2a2o-output-format 与流式组合——Task 7 实现时 outFormat 逻辑直接复用 M1 的响应格式选择，作用在编码器选择上）✓；§3.3 流式细节（行缓冲 Task 3、终止标记 Task 3/4、事件丢弃规则 Global Constraints）✓；§3.6 动态超时（Task 2）+ 三阶段（Task 6）✓；S4-S6（Task 7）✓；Backlog 正确性子集（Task 1/2/8 + stream 真值化 Task 7 + convert Task 9 + log_level Task 2）✓；M3 项（Key 池/评分/冷却//health/keys）与 M4 项（更新/构建）显式出范围。**交接清单中未入 M2 的**：alias-cycle/数值范围校验剩余部分（validator 数值部分已在 Task 1）、authGw try/finally 等测试卫生项（归入 Task 7 顺手项）、DC-4 网关注记、/v1/models capabilities 字段——留在 M3。
- **占位符扫描**：Task 6 测试辅助函数（fakeMonitor/streamOf/readAll）给出意图与规模而非逐行——8 行以内的测试脚手架，属实现细节；Task 7 anthropicUp/openaiUp mock 的 stream 分支描述了行为契约（fixture 帧序列在测试代码中写明）。无 TBD。
- **类型一致性**：StreamEvent 在 Task 3 定义、Task 4/5 复用（解析器/编码器统一事件词汇）✓；TimeoutConfig 在 Task 1 定义、Task 2/6 消费 ✓；`arm(onTimeout)` 统一回调签名在 Task 6 测试与实现间一致（设计裁定：manager 内部判 stage，避免三个回调）✓；M1 的 `resolveKey(cfg, model, ...)` 签名在 Task 7 复用不变 ✓。
- **裁定记录**：真实短定时器代替假时钟（Global Constraints）；responses 编码器最小事件集；anthropic message_start input_tokens 占位 0；arm(onTimeout) 单回调；URL 图像 anthropic 出向 = warn+skip+dropped（Task 8）。
