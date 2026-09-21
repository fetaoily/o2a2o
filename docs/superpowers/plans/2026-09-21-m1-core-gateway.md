# O2A2O M1 核心网关（非流式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可运行的 o2a2o 网关 v0.1：三格式非流式互转、模型驱动路由、动态 Key、`GET /v1/models`、网关鉴权、CLI。

**Architecture:** 每种协议格式实现「格式 ↔ IR」4 个纯函数转换器；请求路径 = 格式识别 → 别名/模型路由 →（跨协议时）IR 转换 → 单 Key 转发上游 → 响应转回客户端格式。同协议直通。全部离线可测（mock 上游）。

**Tech Stack:** Bun + TypeScript (strict)，`yaml` 包解析配置，`Bun.serve` HTTP 服务，`bun test` 测试。

**Spec:** `docs/REQUIREMENTS.md` + `docs/TECH-DESIGN.md`（协议事实已核实，见 TECH-DESIGN §18；执行者须同时读 spec 与本计划）

## Global Constraints

- TypeScript `strict: true`；生成代码**不含中文**（注释/标识符/日志均英文）
- 运行时依赖仅 `yaml` 一个；无框架，HTTP 用 `Bun.serve`
- JSON 字段名是公共契约（对客户端的输出字段名以 TECH-DESIGN §10/§12/§18 核实结果为准，不得自创）
- 上游调用头：anthropic 用 `x-api-key` + `anthropic-version: 2023-06-01`；openai 用 `Authorization: Bearer <key>`
- 上游地址：环境变量 `O2A2O_UPSTREAM_OPENAI` / `O2A2O_UPSTREAM_ANTHROPIC` 覆盖，默认官方端点
- Key 掩码：`key.slice(0,8) + "..." + key.slice(-4)`；任何日志不得输出明文 Key
- `o2a2o_keys` 字段必须在转发前从请求体剥离
- 返回客户端的错误体必须符合其请求协议格式（openai：`{error:{message,type,code}}`；anthropic：`{type:"error",error:{type,message}}`）
- IR 层 `maxTokens` 缺省补 4096（Anthropic 必填）
- Commit 用 conventional 格式（feat/fix/test/chore），单行 subject，不加 Co-Authored-By
- 本计划范围外（M2+）：流式转换、动态超时、多 Key 池/故障转移、自动更新。M1 转发超时固定 60s，Key 取配置中 priority 最小的第一个

## 文件结构（本计划锁定）

```
package.json / tsconfig.json
src/
├── index.ts                  # entry: cli()
├── cli.ts                    # argv 解析 + serve/config 子命令
├── server.ts                 # Bun.serve 路由 + 鉴权
├── config/
│   ├── loader.ts             # YAML + ${ENV} 解析 -> AppConfig
│   ├── validator.ts          # 结构/语义校验
│   └── template.ts           # config init 模板
├── types/
│   ├── ir.ts                 # IRRequest/IRResponse/IRContentPart
│   ├── openai.ts             # openai_chat + openai_responses 类型
│   └── anthropic.ts          # anthropic Messages 类型
├── converters/
│   ├── chat.ts               # chatToIr / irToChat / chatResponseToIr / irToChatResponse
│   ├── anthropic.ts          # anthropicToIr / irToAnthropic / ...
│   ├── responses.ts          # responsesToIr / irToResponses / ...
│   └── errors.ts             # toClientError(status, err, clientFormat)
├── core/
│   ├── format-detector.ts    # detectFormat(path, body)
│   ├── unified-converter.ts  # handleGatewayRequest(): 非流式主流程
│   └── forwarder.ts          # resolveKey + forwardToUpstream
└── utils/
    └── logger.ts             # maskKey + log
tests/
├── config/ converter/ core/  # 单测（fixture 内联）
└── integration/gateway.test.ts
```

（spec §13 的 6 个双向转换器文件合并为按格式 3 个文件——同格式的 4 个函数同改动同测试，聚合更内聚；stream-converter 等留待 M2。）

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/index.ts`, `tests/smoke.test.ts`, `.gitignore`

**Interfaces:**
- Produces: 可运行的 `bun test`；`src/index.ts` 导出 `main()` 占位（后续 Task 12 填充）

- [ ] **Step 1: 创建文件**

`package.json`:
```json
{
  "name": "o2a2o",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "test": "bun test",
    "build": "bun build --compile src/index.ts --outfile dist/o2a2o"
  },
  "dependencies": { "yaml": "^2.5.0" },
  "devDependencies": { "@types/bun": "latest" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`src/index.ts`:
```typescript
export function main(): void {
  // wired up in the CLI task
}

if (import.meta.main) {
  main();
}
```

`tests/smoke.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { main } from "../src/index";

test("main is callable", () => {
  expect(() => main()).not.toThrow();
});
```

`.gitignore`: `node_modules/`, `dist/`, `*.log`

- [ ] **Step 2: 安装并运行**

Run: `bun install && bun test`
Expected: 1 pass

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.json src/index.ts tests/smoke.test.ts .gitignore bun.lock
git commit -m "chore: scaffold bun + typescript project"
```

---

### Task 2: 配置类型与加载器（${ENV} 解析）

**Files:**
- Create: `src/config/loader.ts`
- Test: `tests/config/loader.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface ApiKeyConfig { key: string; priority: number; weight?: number }
export interface ModelConfig { name: string; provider: "openai" | "anthropic"; api_keys: ApiKeyConfig[] }
export interface ServerConfig { port: number; host: string; log_level: string; auth_token?: string }
export interface AppConfig {
  server: ServerConfig;
  models: ModelConfig[];
  aliases: Record<string, string>;
  api_keys: { openai?: string; anthropic?: string };
}
export function loadConfig(path: string): Promise<AppConfig>;   // throws ConfigError with field path
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/config/loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "o2a2o-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const YAML = `
server: { port: 8080, host: "127.0.0.1", log_level: "info" }
models:
  - name: "gpt-4o"
    provider: "openai"
    api_keys:
      - { key: "sk-openai-1", priority: 1 }
  - name: "claude-sonnet-4-5"
    provider: "anthropic"
    api_keys:
      - { key: "${ANTHROPIC_KEY_1}", priority: 1 }
aliases: { sonnet: "claude-sonnet-4-5" }
api_keys: { openai: "${OPENAI_API_KEY}" }
`;

test("resolves ${VAR} from environment", async () => {
  process.env.ANTHROPIC_KEY_1 = "sk-ant-xyz";
  process.env.OPENAI_API_KEY = "sk-fallback";
  const p = join(dir, "o2a2o.yaml");
  writeFileSync(p, YAML);
  const cfg = await loadConfig(p);
  expect(cfg.models[1].api_keys[0].key).toBe("sk-ant-xyz");
  expect(cfg.api_keys.openai).toBe("sk-fallback");
  expect(cfg.server.port).toBe(8080);
});

test("undefined env var fails with field path", async () => {
  delete process.env.ANTHROPIC_KEY_1;
  process.env.OPENAI_API_KEY = "x";
  const p = join(dir, "o2a2o.yaml");
  writeFileSync(p, YAML);
  await expect(loadConfig(p)).rejects.toThrow(/models\[1\].api_keys\[0\].key/);
});

test("missing file fails clearly", async () => {
  await expect(loadConfig(join(dir, "nope.yaml"))).rejects.toThrow(/config file not found/i);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/config/loader.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export class ConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = "ConfigError"; }
}

// interfaces as in Produces above...

const ENV_REF = /^\$\{(.+)\}$/;

function resolveEnv(value: unknown, path: string): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(ENV_REF);
  if (!m) return value;
  const v = process.env[m[1]];
  if (v === undefined) throw new ConfigError(`undefined environment variable at ${path}: \${${m[1]}}`);
  return v;
}

function walk(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, `${path}.${k}`);
    return out;
  }
  return resolveEnv(node, path);
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { throw new ConfigError(`config file not found: ${path}`); }
  const raw = walk(parse(text), "root");
  const cfg = raw as AppConfig;
  cfg.server ??= { port: 8080, host: "127.0.0.1", log_level: "info" };
  cfg.models ??= [];
  cfg.aliases ??= {};
  cfg.api_keys ??= {};
  return cfg;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/config/loader.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts tests/config/loader.test.ts
git commit -m "feat(config): yaml loader with env var resolution"
```

---

### Task 3: 配置校验器与模板

**Files:**
- Create: `src/config/validator.ts`, `src/config/template.ts`
- Test: `tests/config/validator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AppConfig`
- Produces: `validateConfig(cfg: AppConfig): string[]`（空数组=合法，否则为错误消息列表）；`CONFIG_TEMPLATE: string`

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { validateConfig, CONFIG_TEMPLATE } from "../../src/config/validator";
import type { AppConfig } from "../../src/config/loader";

const base = (): AppConfig => ({
  server: { port: 8080, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-1", priority: 1 }] }],
  aliases: {},
  api_keys: {},
});

test("valid config passes", () => expect(validateConfig(base())).toEqual([]));

test("empty models rejected", () => {
  const c = base(); c.models = [];
  expect(validateConfig(c)).toEqual(["models must not be empty"]);
});

test("duplicate model names rejected", () => {
  const c = base();
  c.models.push({ ...c.models[0] });
  expect(validateConfig(c)[0]).toMatch(/duplicate model name/);
});

test("bad provider rejected", () => {
  const c = base();
  (c.models[0] as any).provider = "gemini";
  expect(validateConfig(c)[0]).toMatch(/invalid provider/);
});

test("alias pointing to unknown model rejected", () => {
  const c = base(); c.aliases = { x: "no-such-model" };
  expect(validateConfig(c)[0]).toMatch(/alias 'x' resolves to unknown model/);
});

test("non-loopback host without auth_token rejected", () => {
  const c = base(); c.server.host = "0.0.0.0";
  expect(validateConfig(c)[0]).toMatch(/auth_token is required/);
});

test("template is valid yaml", async () => {
  const { parse } = await import("yaml");
  expect(() => parse(CONFIG_TEMPLATE)).not.toThrow();
});
```

- [ ] **Step 2: 运行确认失败** → `bun test tests/config/validator.test.ts` FAIL

- [ ] **Step 3: 实现**

`src/config/template.ts`：复制 TECH-DESIGN §6.1 的示例配置为 `export const CONFIG_TEMPLATE = \`...\``（原样，注释保留英文）。

`src/config/validator.ts`:
```typescript
import type { AppConfig } from "./loader";
import { CONFIG_TEMPLATE } from "./template";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function validateConfig(cfg: AppConfig): string[] {
  const errs: string[] = [];
  if (!cfg.models?.length) errs.push("models must not be empty");
  const names = new Set<string>();
  for (const m of cfg.models ?? []) {
    if (names.has(m.name)) errs.push(`duplicate model name: ${m.name}`);
    names.add(m.name);
    if (m.provider !== "openai" && m.provider !== "anthropic")
      errs.push(`invalid provider for ${m.name}: ${m.provider} (expected "openai" | "anthropic")`);
  }
  for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
    if (!names.has(target)) errs.push(`alias '${alias}' resolves to unknown model: ${target}`);
  }
  if (cfg.server && !LOOPBACK.has(cfg.server.host) && !cfg.server.auth_token)
    errs.push("server.auth_token is required when binding a non-loopback host");
  return errs;
}
export { CONFIG_TEMPLATE };
```

- [ ] **Step 4: 运行确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/validator.ts src/config/template.ts tests/config/validator.test.ts
git commit -m "feat(config): semantic validation and init template"
```

---

### Task 4: IR 类型 + openai_chat 转换器（含参数策略）

**Files:**
- Create: `src/types/ir.ts`, `src/types/openai.ts`, `src/converters/chat.ts`
- Test: `tests/converters/chat.test.ts`

**Interfaces:**
- Produces（后续所有转换器任务依赖）:
```typescript
// src/types/ir.ts
export type IRContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: unknown };

export interface IRMessage { role: "user" | "assistant" | "tool"; content: string | IRContentPart[] }

export interface IRRequest {
  model: string; system?: string; messages: IRMessage[];
  tools?: { name: string; description?: string; parameters: unknown }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  disableParallelToolUse?: boolean;
  temperature?: number; topP?: number; maxTokens: number; stop?: string[];
  stream: boolean; effort?: string; structuredOutput?: unknown;
}

export interface IRResponse {
  id: string; model: string; content: IRContentPart[];
  stopReason: "stop" | "length" | "tool_use" | "content_filter";
  usage: { inputTokens: number; outputTokens: number };
}

// src/converters/chat.ts
export class ParamError extends Error;  // 400-class: unsupported structural param
export interface ConvResult { ir: IRRequest; dropped: string[] }
export function chatToIr(body: unknown): ConvResult;          // throws ParamError
export function irToChat(ir: IRRequest): Record<string, unknown>;
export function chatResponseToIr(res: unknown): IRResponse;
export function irToChatResponse(ir: IRResponse): Record<string, unknown>;
```

- [ ] **Step 1: 写失败测试**（fixture 内联）

```typescript
import { test, expect } from "bun:test";
import { chatToIr, irToChat, chatResponseToIr, irToChatResponse, ParamError } from "../../src/converters/chat";

const chatReq = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"SF\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "72F" },
  ],
  tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
  tool_choice: "auto", temperature: 0.5, max_tokens: 100, stop: ["END"],
  presence_penalty: 0.5, seed: 42,
};

test("chatToIr hoists system, maps tools round shape, records dropped params", () => {
  const { ir, dropped } = chatToIr(chatReq);
  expect(ir.system).toBe("be brief");
  expect(ir.messages).toHaveLength(3);
  expect(ir.messages[0]).toEqual({ role: "user", content: "hi" });
  const asst = ir.messages[1].content as any[];
  expect(asst[0].type).toBe("tool_use");
  expect(asst[0].input).toEqual({ city: "SF" });
  expect(ir.messages[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1", content: "72F" });
  expect(ir.tools![0]).toEqual({ name: "get_weather", description: "w", parameters: { type: "object" } });
  expect(ir.maxTokens).toBe(100);
  expect(ir.stop).toEqual(["END"]);
  expect(dropped).toContain("presence_penalty");
  expect(dropped).toContain("seed");
});

test("maxTokens defaults to 4096 when absent", () => {
  const { ir } = chatToIr({ model: "m", messages: [{ role: "user", content: "x" }] });
  expect(ir.maxTokens).toBe(4096);
});

test("n > 1 throws ParamError", () => {
  expect(() => chatToIr({ ...chatReq, n: 3 })).toThrow(ParamError);
});

test("response_format json_object throws, json_schema maps", () => {
  expect(() => chatToIr({ ...chatReq, response_format: { type: "json_object" } })).toThrow(/json_object/);
  const { ir } = chatToIr({ ...chatReq, response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
  expect(ir.structuredOutput).toEqual({ type: "object" });
});

test("reasoning_effort maps into ir.effort (none/minimal -> low)", () => {
  expect(chatToIr({ ...chatReq, reasoning_effort: "none" }).ir.effort).toBe("low");
  expect(chatToIr({ ...chatReq, reasoning_effort: "high" }).ir.effort).toBe("high");
});

test("irToChat restores system first and tool_calls shape", () => {
  const { ir } = chatToIr(chatReq);
  const out = irToChat(ir) as any;
  expect(out.messages[0]).toEqual({ role: "system", content: "be brief" });
  expect(out.messages[2].tool_calls[0].function.arguments).toBe("{\"city\":\"SF\"}");
  expect(out.max_tokens).toBe(100);
});

test("response mapping round trip", () => {
  const chatRes = {
    id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hello", tool_calls: [
      { id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const ir = chatResponseToIr(chatRes);
  expect(ir.stopReason).toBe("tool_use");
  expect(ir.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  const back = irToChatResponse(ir) as any;
  expect(back.object).toBe("chat.completion");
  expect(back.choices[0].message.tool_calls[0].id).toBe("c1");
  expect(back.choices[0].finish_reason).toBe("tool_calls");
  expect(back.usage.total_tokens).toBe(15);
});
```

- [ ] **Step 2: 运行确认失败** → `bun test tests/converters/chat.test.ts` FAIL

- [ ] **Step 3: 实现**

`src/types/ir.ts`：按上方 Produces 原样。
`src/types/openai.ts`：宽类型的 request/response 接口（字段 `unknown`/可选，仅供内部标注，不追求完备）。

`src/converters/chat.ts` 要点（完整实现）：
```typescript
const DROPPED = ["presence_penalty","frequency_penalty","logit_bias","seed","logprobs",
  "top_logprobs","verbosity","prediction","web_search_options","store","service_tier",
  "safety_identifier","user","metadata"] as const;
const EFFORT = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

export function chatToIr(body: any): ConvResult {
  if (body.n !== undefined && body.n > 1)
    throw new ParamError("`n` must be 1: target provider does not support multiple choices");
  const rf = body.response_format;
  if (rf?.type === "json_object")
    throw new ParamError('response_format json_object is not supported; use {"type":"json_schema"}');
  const dropped = [...DROPPED.filter((p) => body[p] !== undefined)];
  if (body.parallel_tool_calls === true) dropped.push("parallel_tool_calls");
  if (body.parallel_tool_calls === false) /* mapped via disableParallelToolUse */;
  const system: string[] = []; const messages: IRMessage[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") { system.push(String(m.content)); continue; }
    if (m.role === "tool") {
      messages.push({ role: "tool", content: [{ type: "tool_result", toolUseId: m.tool_call_id, content: m.content }] });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const parts: IRContentPart[] = [];
      if (m.content) parts.push({ type: "text", text: String(m.content) });
      for (const c of m.tool_calls)
        parts.push({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") });
      messages.push({ role: "assistant", content: parts }); continue;
    }
    messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : mapContentParts(m.content) });
  }
  return {
    ir: {
      model: body.model, system: system.join("\n\n") || undefined, messages,
      tools: body.tools?.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
      toolChoice: normalizeToolChoice(body.tool_choice),
      disableParallelToolUse: body.parallel_tool_calls === false || undefined,
      temperature: body.temperature, topP: body.top_p,
      maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
      stop: body.stop, stream: body.stream === true,
      effort: body.reasoning_effort ? EFFORT[body.reasoning_effort as keyof typeof EFFORT] : undefined,
      structuredOutput: rf?.type === "json_schema" ? rf.json_schema?.schema : undefined,
    },
    dropped,
  };
}
```
`irToChat`：system → 首条 `role:"system"`；tool_result 消息 → `{role:"tool", tool_call_id, content}`；tool_use parts → `tool_calls[]`（`arguments` `JSON.stringify`）；`max_tokens` 字段名还原；`response_format` 不还原（出方向由目标格式决定）。
`chatResponseToIr`：`finish_reason` 映射 `{stop→stop, length→length, tool_calls→tool_use, content_filter→content_filter}`；content 与 tool_calls → parts；usage → inputTokens/outputTokens。
`irToChatResponse`：`{id, object:"chat.completion", created:Math.floor(Date.now()/1000), model, choices:[{index:0, message:{role:"assistant", content:joinText(ir.content) ?? null, tool_calls: toolCallsOrNull}, finish_reason: REVERSE[ir.stopReason]}], usage:{prompt_tokens, completion_tokens, total_tokens: in+out}}`，`REVERSE = {stop:"stop", length:"length", tool_use:"tool_calls", content_filter:"content_filter"}`。

- [ ] **Step 4: 运行确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/ir.ts src/types/openai.ts src/converters/chat.ts tests/converters/chat.test.ts
git commit -m "feat(converters): openai_chat <-> IR with param policy"
```

---

### Task 5: anthropic 转换器

**Files:**
- Create: `src/types/anthropic.ts`, `src/converters/anthropic.ts`
- Test: `tests/converters/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 4 的 IR 类型
- Produces:
```typescript
export function anthropicToIr(body: unknown): ConvResult;   // ConvResult 从 ./chat 导入复用
export function irToAnthropic(ir: IRRequest): Record<string, unknown>;
export function anthropicResponseToIr(res: unknown): IRResponse;
export function irToAnthropicResponse(ir: IRResponse): Record<string, unknown>;
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { anthropicToIr, irToAnthropic, anthropicResponseToIr, irToAnthropicResponse } from "../../src/converters/anthropic";

const antReq = {
  model: "gpt-4o", max_tokens: 512, system: "be brief",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  ],
  tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
  tool_choice: { type: "any" }, stop_sequences: ["END"],
  metadata: { user_id: "u1" },
};

test("anthropicToIr maps blocks, strips cache_control/metadata", () => {
  const { ir, dropped } = anthropicToIr(antReq);
  expect(ir.system).toBe("be brief");
  expect(ir.maxTokens).toBe(512);
  expect((ir.messages[0].content as any[])[0]).toEqual({ type: "text", text: "hi" });
  expect((ir.messages[1].content as any[])[0]).toMatchObject({ type: "tool_use", id: "toolu_1", input: { a: 1 } });
  expect(ir.messages[2].role).toBe("tool");
  expect(ir.tools![0].parameters).toEqual({ type: "object" });
  expect(ir.toolChoice).toBe("required");
  expect(ir.stop).toEqual(["END"]);
  expect(dropped).toContain("cache_control");
  expect(dropped).toContain("metadata");
});

test("irToAnthropic restores native shape incl tool_choice any", () => {
  const { ir } = anthropicToIr(antReq);
  const out = irToAnthropic(ir) as any;
  expect(out.system).toBe("be brief");
  expect(out.max_tokens).toBe(512);
  expect(out.tool_choice).toEqual({ type: "any" });
  expect(out.stop_sequences).toEqual(["END"]);
  expect(out.messages[2].role).toBe("user");  // tool_result rides on a user message
});

test("ir.structuredOutput -> output_config.format; ir.effort -> output_config.effort", () => {
  const out = irToAnthropic({ model: "m", messages: [], maxTokens: 10, stream: false,
    structuredOutput: { type: "object" }, effort: "high" } as any) as any;
  expect(out.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } }, effort: "high" });
});

test("response mapping incl refusal -> content_filter and pause_turn -> stop", () => {
  const res = { id: "msg_1", model: "claude-x", stop_reason: "refusal",
    content: [{ type: "text", text: "no" }], usage: { input_tokens: 3, output_tokens: 2 } };
  expect(anthropicResponseToIr(res).stopReason).toBe("content_filter");
  expect(anthropicResponseToIr({ ...res, stop_reason: "pause_turn" }).stopReason).toBe("stop");
  const back = irToAnthropicResponse(anthropicResponseToIr(res)) as any;
  expect(back.type).toBe("message");
  expect(back.stop_reason).toBe("refusal");
  expect(back.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**（完整实现，要点）

`anthropicToIr`：`system`（string 或 `{type:"text"}[]` join）→ `ir.system`；content 块映射 text/tool_use/tool_result/image（`source:{base64,media_type}` → image part）；含 `cache_control` 的块剥离并 `dropped.push("cache_control")`；`metadata` → dropped；`thinking` 块丢弃记 debug；`tool_choice` 映射 `{auto→"auto", any→"required", none→"none", {type:"tool",name}→{name}}`；`stop_sequences→stop`；`output_config.format.schema→structuredOutput`；`output_config.effort→effort`；`max_tokens→maxTokens`（必填，无默认分支）。
`irToAnthropic`：`toolChoice` 逆映射（required→`{type:"any"}`，`{name}`→`{type:"tool",name}`）；tool 角色消息并入 user 消息（anthropic 要求 tool_result 在 user 消息内）；`disableParallelToolUse` → `tool_choice:{type:"auto",disable_parallel_tool_use:true}`；`structuredOutput/effort` → `output_config`（均存在才输出该对象）。
`anthropicResponseToIr`：`stop_reason` 映射 `{end_turn→stop, stop_sequence→stop, max_tokens→length, tool_use→tool_use, refusal→content_filter, pause_turn→stop(记 warn)}`；usage 取 `input_tokens/output_tokens`（忽略 cache_* 字段）。
`irToAnthropicResponse`：`{id, type:"message", role:"assistant", model, content, stop_reason: 逆映射, stop_sequence:null, usage:{input_tokens, output_tokens}}`。

- [ ] **Step 4: 运行确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/anthropic.ts src/converters/anthropic.ts tests/converters/anthropic.test.ts
git commit -m "feat(converters): anthropic messages <-> IR"
```

---

### Task 6: openai_responses 转换器

**Files:**
- Create: `src/converters/responses.ts`
- Test: `tests/converters/responses.test.ts`

**Interfaces:**
- Consumes: IR 类型
- Produces:
```typescript
export function responsesToIr(body: unknown): ConvResult;
export function irToResponses(ir: IRRequest): Record<string, unknown>;
export function responsesResponseToIr(res: unknown): IRResponse;
export function irToResponsesResponse(ir: IRResponse): Record<string, unknown>;
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { responsesToIr, irToResponses, responsesResponseToIr, irToResponsesResponse } from "../../src/converters/responses";

const respReq = {
  model: "claude-sonnet-4-5",
  instructions: "be brief",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_1", name: "f", arguments: "{\"a\":1}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ],
  max_output_tokens: 256, temperature: 0.3,
  text: { format: { type: "json_schema", json_schema: { schema: { type: "object" } } } },
  verbosity: "low",
};

test("responsesToIr maps instructions/input items and records dropped", () => {
  const { ir, dropped } = responsesToIr(respReq);
  expect(ir.system).toBe("be brief");
  expect(ir.maxTokens).toBe(256);
  expect(ir.messages).toHaveLength(3);
  expect((ir.messages[1].content as any[])[0]).toMatchObject({ type: "tool_use", id: "call_1", input: { a: 1 } });
  expect(ir.messages[2].role).toBe("tool");
  expect(ir.structuredOutput).toEqual({ type: "object" });
  expect(dropped).toContain("verbosity");
});

test("string input becomes a single user message", () => {
  const { ir } = responsesToIr({ model: "m", input: "hello" });
  expect(ir.messages).toEqual([{ role: "user", content: "hello" }]);
  expect(ir.maxTokens).toBe(4096);
});

test("irToResponses restores items", () => {
  const { ir } = responsesToIr(respReq);
  const out = irToResponses(ir) as any;
  expect(out.instructions).toBe("be brief");
  expect(out.max_output_tokens).toBe(256);
  expect(out.input[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
  expect(out.input[1].arguments).toBe("{\"a\":1}");
});

test("response mapping: output_text, function_call, incomplete reason", () => {
  const res = { id: "resp_1", model: "gpt-4o", status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hey", annotations: [] }] },
      { id: "fc_1", type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
    ],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } };
  const ir = responsesResponseToIr(res);
  expect(ir.stopReason).toBe("length");
  expect(ir.content[0]).toEqual({ type: "text", text: "hey" });
  expect(ir.content[1]).toMatchObject({ type: "tool_use", name: "f" });
  const back = irToResponsesResponse(ir) as any;
  expect(back.object).toBe("response");
  expect(back.status).toBe("completed");
  expect(back.output[0].content[0].type).toBe("output_text");
  expect(back.usage).toEqual({ input_tokens: 7, output_tokens: 4, total_tokens: 11 });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**（完整实现，要点）

`responsesToIr`：`instructions→system`；`input` string → 单条 user；数组 item：`message`（role + content `input_text`/`output_text`/`summary_text` 取 text）、`function_call`（→assistant tool_use，id=call_id，input=JSON.parse(arguments)）、`function_call_output`（→tool 消息 tool_result）；`max_output_tokens→maxTokens`（缺省 4096）；`text.format.json_schema.schema→structuredOutput`；`reasoning.effort→effort`；`verbosity`/`previous_response_id`/`store`/`truncation`/`metadata` → dropped。
`irToResponses`：逆映射；tool_use → `function_call` item（arguments stringify）；tool 消息 → `function_call_output` item。
`responsesResponseToIr`：`output[]` 中 message 的 `output_text` 块 join 为 text part、`function_call` → tool_use part；`status:"incomplete" && incomplete_details.reason==="max_output_tokens"` → length，`"failed"` → content_filter 近似（`response.error` 存文本则并入 text part）；usage 取 `input_tokens/output_tokens`。
`irToResponsesResponse`：`{id, object:"response", created_at, status:"completed", model, output:[message item / function_call items], usage:{input_tokens, output_tokens, total_tokens}}`。

- [ ] **Step 4: 运行确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/converters/responses.ts tests/converters/responses.test.ts
git commit -m "feat(converters): openai_responses <-> IR"
```

---

### Task 7: 格式识别器

**Files:**
- Create: `src/core/format-detector.ts`
- Test: `tests/core/format-detector.test.ts`

**Interfaces:**
- Produces:
```typescript
export type InputFormat = "openai_chat" | "openai_responses" | "anthropic";
export function detectFormat(path: string, body: unknown): InputFormat;  // throws Error when undetectable
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { detectFormat } from "../../src/core/format-detector";

test("by path", () => {
  expect(detectFormat("/v1/chat/completions", {})).toBe("openai_chat");
  expect(detectFormat("/v1/responses", {})).toBe("openai_responses");
  expect(detectFormat("/v1/messages", {})).toBe("anthropic");
});
test("body fallback: input -> responses", () =>
  expect(detectFormat("/", { input: "x" })).toBe("openai_responses"));
test("body fallback: messages[0].role -> chat", () =>
  expect(detectFormat("/", { messages: [{ role: "user", content: "x" }] })).toBe("openai_chat"));
test("body fallback: messages + max_tokens -> anthropic", () =>
  expect(detectFormat("/", { messages: [{ content: "x" }], max_tokens: 10 })).toBe("anthropic"));
test("undetectable throws", () =>
  expect(() => detectFormat("/", {})).toThrow(/unable to detect/i));
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：路径 `endsWith` 三分支；body 兜底按 TECH-DESIGN §5 表顺序（`input!==undefined` → responses；`messages[0]?.role` 存在 → chat；`Array.isArray(messages) && max_tokens!==undefined` → anthropic；否则 throw `"unable to detect request format"`）。
- [ ] **Step 4: 运行确认通过** → PASS
- [ ] **Step 5: Commit**

```bash
git add src/core/format-detector.ts tests/core/format-detector.test.ts
git commit -m "feat(core): request format detection by path and body"
```

---

### Task 8: 错误映射器

**Files:**
- Create: `src/converters/errors.ts`
- Test: `tests/converters/errors.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `InputFormat`
- Produces:
```typescript
export function toClientError(status: number, err: unknown, clientFormat: InputFormat):
  { status: number; body: Record<string, unknown> };
// err: Error | { upstream status, upstream body } — upstream anthropic body {error:{type,message}} / openai {error:{message,type,code}}
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { toClientError } from "../../src/converters/errors";

test("openai client gets openai error shape", () => {
  const r = toClientError(400, new Error("bad input"), "openai_chat");
  expect(r.status).toBe(400);
  expect(r.body.error).toMatchObject({ message: "bad input", type: "invalid_request_error" });
});
test("anthropic client gets anthropic error shape", () => {
  const r = toClientError(502, { upstream: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, "anthropic");
  expect(r.body).toMatchObject({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  expect(r.body.request_id).toBeDefined();   // generated request id, never upstream's raw shape leak
});
test("upstream openai error -> anthropic client shape", () => {
  const r = toClientError(502, { upstream: 429, body: { error: { message: "rate limited", type: "requests", code: "x" } } }, "anthropic");
  expect(r.body.error).toMatchObject({ type: "rate_limit_error", message: "rate limited" });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：错误类型映射表（openai→anthropic：`invalid_request_error→invalid_request_error`、`authentication→authentication_error`、`rate/429→rate_limit_error`、5xx→`api_error`；anthropic→openai 反向同理）；网关自身错误（`Error` 实例）按 clientFormat 生成对应形状（openai `{error:{message,type:"invalid_request_error",code:null}}` / anthropic `{type:"error",error:{type:"invalid_request_error",message},request_id}`）；`ParamError` 恒 400。request_id 生成用 `crypto.randomUUID()` 前缀 `req_`。
- [ ] **Step 4: 运行确认通过** → PASS
- [ ] **Step 5: Commit**

```bash
git add src/converters/errors.ts tests/converters/errors.test.ts
git commit -m "feat(converters): cross-format error body mapping"
```

---

### Task 9: Key 解析与上游转发（单 Key，M1 版）

**Files:**
- Create: `src/core/forwarder.ts`, `src/utils/logger.ts`
- Test: `tests/core/forwarder.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（Task 2）
- Produces:
```typescript
export type Provider = "openai" | "anthropic";
export function resolveKey(cfg: AppConfig, provider: Provider, headers: Record<string, string | undefined>, body: Record<string, unknown>):
  { key: string; body: Record<string, unknown> };   // returned body has o2a2o_keys stripped
export const UPSTREAM_TIMEOUT_MS = 60_000;           // fixed in M1; dynamic calc arrives in M2
export async function forwardToUpstream(opts: {
  provider: Provider; endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
  body: Record<string, unknown>; key: string;
}): Promise<Response>;                                 // non-2xx -> throws UpstreamError { status, body }
export class UpstreamError extends Error { status: number; body: unknown }
export function upstreamBase(provider: Provider): string; // env override aware
```

- [ ] **Step 1: 写失败测试**（stub `global.fetch`）

```typescript
import { test, expect, mock, beforeEach } from "bun:test";
import { resolveKey, forwardToUpstream, UpstreamError } from "../../src/core/forwarder";
import type { AppConfig } from "../../src/config/loader";

const cfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [
    { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-cfg", priority: 1 }] },
    { name: "claude", provider: "anthropic", api_keys: [{ key: "sk-ant-cfg", priority: 2 }, { key: "sk-ant-cfg2", priority: 1 }] },
  ],
  aliases: {}, api_keys: { openai: "sk-global" },
};

test("key priority: header > body > lowest-priority config > global", () => {
  expect(resolveKey(cfg, "openai", { "x-o2a2o-openai-key": "sk-hdr" }, {}).key).toBe("sk-hdr");
  expect(resolveKey(cfg, "openai", {}, { o2a2o_keys: { openai: "sk-body" } }).key).toBe("sk-body");
  expect(resolveKey(cfg, "anthropic", {}, {}).key).toBe("sk-ant-cfg2");   // priority 1 wins
  expect(resolveKey(cfg, "openai", {}, {}).key).toBe("sk-cfg");
});
test("o2a2o_keys stripped from returned body", () => {
  const { body } = resolveKey(cfg, "openai", {}, { o2a2o_keys: { openai: "k" }, model: "gpt-4o" });
  expect(body).toEqual({ model: "gpt-4o" });
});
test("no key anywhere throws", () => {
  expect(() => resolveKey({ ...cfg, api_keys: {} }, "anthropic", {}, { model: "nope" } as any)).toThrow(/no api key/i);
});

beforeEach(() => { mock.restore(); });
test("forwardToUpstream sends provider-correct headers; non-2xx throws UpstreamError", async () => {
  const fetchMock = mock(async (url: any, init: any) => {
    if (String(url).includes("anthropic")) {
      expect(init.headers["x-api-key"]).toBe("sk-ant");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "rate limited", type: "requests" } }), { status: 429 });
  });
  global.fetch = fetchMock as any;
  process.env.O2A2O_UPSTREAM_ANTHROPIC = "http://localhost:9";
  const ok = await forwardToUpstream({ provider: "anthropic", endpoint: "/v1/messages", body: {} as any, key: "sk-ant" });
  expect(ok.status).toBe(200);
  try {
    await forwardToUpstream({ provider: "openai", endpoint: "/v1/chat/completions", body: {} as any, key: "sk-x" });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).status).toBe(429);
  }
  delete process.env.O2A2O_UPSTREAM_ANTHROPIC;
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**

`src/utils/logger.ts`：`export function maskKey(key: string): string { return key.slice(0, 8) + "..." + key.slice(-4); }` + 极简 `log/warn/error`（按 `log_level` 过滤，输出含 ISO 时间戳）。

`src/core/forwarder.ts` 要点：
```typescript
export function upstreamBase(provider: Provider): string {
  return provider === "openai"
    ? (process.env.O2A2O_UPSTREAM_OPENAI ?? "https://api.openai.com")
    : (process.env.O2A2O_UPSTREAM_ANTHROPIC ?? "https://api.anthropic.com");
}

export function resolveKey(cfg, provider, headers, body) {
  const hdrKey = headers[provider === "openai" ? "x-o2a2o-openai-key" : "x-o2a2o-anthropic-key"];
  const { o2a2o_keys, ...rest } = body;          // strip ALWAYS
  const bodyKey = o2a2o_keys?.[provider];
  const modelKeys = cfg.models.filter(m => m.provider === provider)
    .flatMap(m => m.api_keys).sort((a, b) => a.priority - b.priority);
  const key = hdrKey ?? bodyKey ?? modelKeys[0]?.key ?? cfg.api_keys[provider];
  if (!key) throw new Error(`no api key available for provider ${provider}`);
  return { key, body: rest };
}

export async function forwardToUpstream(opts): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = opts.provider === "anthropic"
      ? { "x-api-key": opts.key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
      : { "authorization": `Bearer ${opts.key}`, "content-type": "application/json" };
    const res = await fetch(upstreamBase(opts.provider) + opts.endpoint, {
      method: "POST", headers, body: JSON.stringify(opts.body), signal: controller.signal });
    if (!res.ok) throw new UpstreamError(res.status, await res.json().catch(() => ({})));
    return res;
  } finally { clearTimeout(timer); }
}
```
注意：`resolveKey` 的 modelKeys 是「同 provider 全部 Key 中取 priority 最小者」——M1 简化（无健康池）；M3 引入池后此函数改为查询 ApiKeyPool。日志输出 Key 一律 `maskKey`。

- [ ] **Step 4: 运行确认通过** → PASS
- [ ] **Step 5: Commit**

```bash
git add src/core/forwarder.ts src/utils/logger.ts tests/core/forwarder.test.ts
git commit -m "feat(core): single-key resolution and upstream forwarding"
```

---

### Task 10: 统一转换主流程 + HTTP 服务（非流式）

**Files:**
- Create: `src/core/unified-converter.ts`, `src/server.ts`
- Test: `tests/integration/gateway.test.ts`（首个集成测试）

**Interfaces:**
- Consumes: Task 2-9 全部
- Produces:
```typescript
// unified-converter.ts
export interface GatewayOutcome {
  status: number;
  body: Record<string, unknown>;
  droppedParams?: string[];        // -> x-o2a2o-dropped header
}
export async function handleGatewayRequest(cfg: AppConfig, path: string, body: Record<string, unknown>, headers: Record<string, string | undefined>): Promise<GatewayOutcome>;

// server.ts
export function startGateway(cfg: AppConfig): Bun.Server;
```

- [ ] **Step 1: 写失败集成测试**（mock 上游 + 真网关，覆盖 S1/S2/S3/S9/S12）

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startGateway } from "../../src/server";
import type { AppConfig } from "../../src/config/loader";

let anthropicUp: Bun.Server; let openaiUp: Bun.Server; let gw: Bun.Server;

beforeAll(() => {
  anthropicUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      anthropicSeen = body;
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "from-claude" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    },
  });
  openaiUp = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as any;
      openaiSeen = body;
      return Response.json({
        id: "chatcmpl-1", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from-gpt" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  });
  process.env.O2A2O_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${anthropicUp.port}`;
  process.env.O2A2O_UPSTREAM_OPENAI = `http://127.0.0.1:${openaiUp.port}`;
  const cfg: AppConfig = {
    server: { port: 0, host: "127.0.0.1", log_level: "info" },
    models: [
      { name: "gpt-4o", provider: "openai", api_keys: [{ key: "sk-oai", priority: 1 }] },
      { name: "claude-sonnet-4-5", provider: "anthropic", api_keys: [{ key: "sk-ant", priority: 1 }] },
    ],
    aliases: { sonnet: "claude-sonnet-4-5" }, api_keys: {},
  };
  gw = startGateway(cfg);
});
afterAll(() => { gw.stop(true); anthropicUp.stop(true); openaiUp.stop(true); });

let anthropicSeen: any; let openaiSeen: any;
const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gw.port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });

test("S1: openai_chat client -> anthropic model, response in openai_chat shape", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], temperature: 0.5, presence_penalty: 0.4 });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("from-claude");
  expect(anthropicSeen.system).toBeUndefined();
  expect(anthropicSeen.max_tokens).toBe(4096);           // defaulted
  expect(anthropicSeen.messages[0].content).toBe("hi");  // string content
  expect(res.headers.get("x-o2a2o-dropped")).toBe("presence_penalty");
});

test("S2: openai_responses client -> anthropic model", async () => {
  const res = await post("/v1/responses", { model: "claude-sonnet-4-5", input: "hi" });
  const body = await res.json() as any;
  expect(body.object).toBe("response");
  expect(body.output[0].content[0].text).toBe("from-claude");
});

test("S3: anthropic client -> openai model", async () => {
  const res = await post("/v1/messages", { model: "gpt-4o", max_tokens: 99, messages: [{ role: "user", content: "hi" }] },
    { "x-api-key": "placeholder", "anthropic-version": "2023-06-01" });
  const body = await res.json() as any;
  expect(body.type).toBe("message");
  expect(body.content[0].text).toBe("from-gpt");
  expect(body.stop_reason).toBe("end_turn");
  expect(openaiSeen.max_tokens).toBe(99);
  expect(openaiSeen.messages[0].role).toBe("user");
});

test("S9: same-provider passthrough is transparent", async () => {
  const res = await post("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  const body = await res.json() as any;
  expect(body.choices[0].message.content).toBe("from-gpt");
  expect(openaiSeen.messages).toEqual([{ role: "user", content: "hi" }]);   // body untouched
});

test("alias resolves (sonnet)", async () => {
  const res = await post("/v1/chat/completions", { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  expect(anthropicSeen.model).toBe("claude-sonnet-4-5");
});

test("S12a: json_schema maps through to output_config.format", async () => {
  await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }],
    response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
  expect(anthropicSeen.output_config.format).toEqual({ type: "json_schema", schema: { type: "object" } });
});
test("S12b: json_object rejected with 400 openai-shaped error", async () => {
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }],
    response_format: { type: "json_object" } });
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.message).toMatch(/json_object/);
});

test("unknown model -> 400 in client format", async () => {
  const res = await post("/v1/chat/completions", { model: "nope", messages: [] });
  expect(res.status).toBe(400);
  expect((await res.json() as any).error.message).toMatch(/nope/);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL（server 模块不存在）

- [ ] **Step 3: 实现**

`src/core/unified-converter.ts` 主流程（完整实现）：
```typescript
const FORMAT_PROVIDER = { openai_chat: "openai", openai_responses: "openai", anthropic: "anthropic" } as const;

export async function handleGatewayRequest(cfg, path, body, headers): Promise<GatewayOutcome> {
  const format = detectFormat(path, body);
  const requested = cfg.aliases[body.model] ?? body.model;
  const model = cfg.models.find(m => m.name === requested);
  if (!model) throw new ParamError(`no route configured for model: ${String(body.model)}`);
  const targetProvider = model.provider;
  const sourceProvider = FORMAT_PROVIDER[format];

  // key resolution happens BEFORE conversion so o2a2o_keys never enters any converter
  const { key, body: cleanBody } = resolveKey(cfg, targetProvider, headers, body);

  let upstreamBody: Record<string, unknown>;
  let dropped: string[] | undefined;
  if (targetProvider === sourceProvider) {
    upstreamBody = cleanBody;                                   // passthrough, zero conversion
  } else {
    const conv = TO_IR[format](cleanBody);                       // { ir, dropped } | throws ParamError
    dropped = conv.dropped.length ? conv.dropped : undefined;
    const ir = { ...conv.ir, model: model.name };
    upstreamBody = FROM_IR[targetProvider](ir);                  // irToChat | irToAnthropic
  }
  const endpoint = targetProvider === "anthropic" ? "/v1/messages"
    : (format === "openai_responses" && targetProvider === "openai") ? "/v1/responses"
    : "/v1/chat/completions";
  // note: cross-provider to openai always targets /v1/chat/completions in M1
  // (responses-target conversion from anthropic source is format-level, not provider-level)

  const upstreamRes = await forwardToUpstream({ provider: targetProvider, endpoint, body: upstreamBody, key });
  const upstreamJson = await upstreamRes.json() as Record<string, unknown>;

  if (format === "anthropic" && targetProvider === "anthropic") return { status: 200, body: upstreamJson, droppedParams: dropped };
  if (targetProvider === "anthropic") {
    const ir = anthropicResponseToIr(upstreamJson);
    return { status: 200, body: format === "openai_responses" ? irToResponsesResponse(ir) : irToChatResponse(ir), droppedParams: dropped };
  }
  if (format === "anthropic") {
    const ir = chatResponseToIr(upstreamJson);
    return { status: 200, body: irToAnthropicResponse(ir), droppedParams: dropped };
  }
  return { status: 200, body: upstreamJson, droppedParams: dropped };   // openai<->openai passthrough
}
```
（`TO_IR`/`FROM_IR` 为格式→函数映射表；openai_chat↔openai_responses 互转走 IR：source format chat 且 provider openai 且客户端格式…——M1 中 openai→openai 恒直通，两种 openai 格式间的互转仅在跨 provider 回程时发生，上表已覆盖。）

`src/server.ts`：
```typescript
export function startGateway(cfg: AppConfig): Bun.Server {
  return Bun.serve({
    port: cfg.server.port, hostname: cfg.server.host,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && ["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(url.pathname)) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const headers = Object.fromEntries(req.headers.entries());
        try {
          const out = await handleGatewayRequest(cfg, url.pathname, body, headers);
          const h: Record<string, string> = { "content-type": "application/json" };
          if (out.droppedParams) h["x-o2a2o-dropped"] = out.droppedParams.join(",");
          return new Response(JSON.stringify(out.body), { status: out.status, headers: h });
        } catch (e) {
          const status = e instanceof ParamError ? 400 : e instanceof UpstreamError ? e.status : 500;
          const fmt = detectFormatSafe(url.pathname, body);     // never throws; defaults openai_chat
          const err = toClientError(status, e, fmt);
          return new Response(JSON.stringify(err.body), { status: err.status, headers: { "content-type": "application/json" } });
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/models") return modelsHandler(cfg, req);   // Task 11 填充，先返回 501 占位
      return new Response(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }), { status: 404 });
    },
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/integration/gateway.test.ts` → PASS（Task 11 前占位断言不涉 models）

- [ ] **Step 5: Commit**

```bash
git add src/core/unified-converter.ts src/server.ts tests/integration/gateway.test.ts
git commit -m "feat(core): non-stream conversion pipeline and http gateway"
```

---

### Task 11: GET /v1/models 双格式 + 网关鉴权

**Files:**
- Modify: `src/server.ts`（models 路由 + 鉴权中间）
- Create: `src/core/models-endpoint.ts`
- Test: `tests/core/models-endpoint.test.ts` + 扩展 `tests/integration/gateway.test.ts`

**Interfaces:**
- Consumes: `AppConfig`
- Produces:
```typescript
export function modelsBody(cfg: AppConfig, anthropicShape: boolean): Record<string, unknown>;
export function checkAuth(cfg: AppConfig, headers: Record<string, string | undefined>): boolean;
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { modelsBody, checkAuth } from "../../src/core/models-endpoint";
import type { AppConfig } from "../../src/config/loader";

const cfg: AppConfig = {
  server: { port: 0, host: "127.0.0.1", log_level: "info" },
  models: [{ name: "gpt-4o", provider: "openai", api_keys: [{ key: "k", priority: 1 }] }],
  aliases: {}, api_keys: {},
};

test("S10 openai shape by default", () => {
  const b = modelsBody(cfg, false) as any;
  expect(b.object).toBe("list");
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", object: "model", owned_by: "openai" });
});
test("S10 anthropic shape on demand", () => {
  const b = modelsBody(cfg, true) as any;
  expect(b.data[0]).toMatchObject({ id: "gpt-4o", type: "model", display_name: "gpt-4o" });
  expect(b.has_more).toBe(false);
});
test("auth: token configured -> Bearer required", () => {
  const c = { ...cfg, server: { ...cfg.server, auth_token: "t0ken" } };
  expect(checkAuth(c, { authorization: "Bearer t0ken" })).toBe(true);
  expect(checkAuth(c, {})).toBe(false);
  expect(checkAuth(c, { authorization: "Bearer wrong" })).toBe(false);
});
test("auth: no token configured -> always pass", () =>
  expect(checkAuth(cfg, {})).toBe(true));
```

集成测试追加（gateway.test.ts）：
```typescript
test("S10: /v1/models returns openai shape; anthropic shape with x-api-key header", async () => {
  const a = await (await fetch(`http://127.0.0.1:${gw.port}/v1/models`)).json() as any;
  expect(a.object).toBe("list");
  const b = await (await fetch(`http://127.0.0.1:${gw.port}/v1/models`, { headers: { "x-api-key": "x" } })).json() as any;
  expect(b.data[0].type).toBe("model");
});
test("S11: auth_token enforced", async () => {
  // separate gateway instance with auth_token set
  const authGw = startGateway({ ...cfgBase, server: { ...cfgBase.server, port: 0, auth_token: "sec" } });
  const noAuth = await fetch(`http://127.0.0.1:${authGw.port}/v1/models`);
  expect(noAuth.status).toBe(401);
  const withAuth = await fetch(`http://127.0.0.1:${authGw.port}/v1/models`, { headers: { authorization: "Bearer sec" } });
  expect(withAuth.status).toBe(200);
  authGw.stop(true);
});
```
（`cfgBase` 提取为文件级变量供两个网关复用。）

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**

`models-endpoint.ts`：
```typescript
export function modelsBody(cfg: AppConfig, anthropicShape: boolean) {
  if (!anthropicShape) return {
    object: "list",
    data: cfg.models.map(m => ({ id: m.name, object: "model", created: 0, owned_by: m.provider })),
  };
  const ids = cfg.models.map(m => m.name);
  return {
    data: cfg.models.map(m => ({ id: m.name, type: "model", display_name: m.name,
      created_at: new Date(0).toISOString(), max_input_tokens: null, max_tokens: null })),
    first_id: ids[0] ?? null, has_more: false, last_id: ids[ids.length - 1] ?? null,
  };
}
export function checkAuth(cfg, headers) {
  if (!cfg.server.auth_token) return true;
  return headers.authorization === `Bearer ${cfg.server.auth_token}`;
}
```
`server.ts`：`fetch` 入口先 `if (!checkAuth(cfg, headers)) return 401`（body 用 openai 形状 `{error:{message:"invalid api key",type:"authentication_error"}}`——401 时格式未知，采用 openai 形状并在 PR 说明）；`/v1/models` 路由：`anthropicShape = req.headers.has("anthropic-version") || req.headers.has("x-api-key")`。

- [ ] **Step 4: 运行确认通过** → `bun test` 全绿
- [ ] **Step 5: Commit**

```bash
git add src/core/models-endpoint.ts src/server.ts tests/core/models-endpoint.test.ts tests/integration/gateway.test.ts
git commit -m "feat(server): dual-format models endpoint and bearer auth"
```

---

### Task 12: CLI 与入口

**Files:**
- Create: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 2/3（loadConfig/validateConfig/CONFIG_TEMPLATE）、Task 11（startGateway）
- Produces:
```typescript
export function parseArgv(argv: string[]):
  { cmd: "serve"; configPath: string; port?: number }
  | { cmd: "config"; sub: "init" | "validate" | "routes"; configPath?: string }
  | { cmd: "version" }
  | { cmd: "help" };
export async function runCli(argv: string[]): Promise<number>;  // exit code
```

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from "bun:test";
import { parseArgv } from "../src/cli";

test("serve with defaults", () =>
  expect(parseArgv(["serve"])).toEqual({ cmd: "serve", configPath: "./o2a2o.yaml", port: undefined }));
test("serve with flags", () =>
  expect(parseArgv(["serve", "--config", "x.yaml", "--port", "9090"])).toEqual({ cmd: "serve", configPath: "x.yaml", port: 9090 }));
test("config subcommands", () => {
  expect(parseArgv(["config", "init"])).toEqual({ cmd: "config", sub: "init", configPath: undefined });
  expect(parseArgv(["config", "validate", "y.yaml"])).toEqual({ cmd: "config", sub: "validate", configPath: "y.yaml" });
});
test("version and unknown", () => {
  expect(parseArgv(["version"]).cmd).toBe("version");
  expect(parseArgv(["wat"]).cmd).toBe("help");
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**

`src/cli.ts`：手写 argv 扫描（无依赖）：`serve`（`--config` 默认 `./o2a2o.yaml`，`--port` 覆盖 `server.port`）；`config init` 打印 `CONFIG_TEMPLATE`；`config validate <path>`：loadConfig + validateConfig，错误逐行打印到 stderr，exit 1；`config routes` 打印模型/别名/Key 掩码表；`version` 打印 `0.1.0`。serve 流程：load → validate（非空错误列表 exit 1）→ `startGateway` → 打印监听地址。
`src/index.ts`：`main()` 改为 `process.exitCode = await runCli(process.argv.slice(2))`。

- [ ] **Step 4: 运行确认通过** → `bun test` 全绿；手动冒烟：`bun run src/index.ts config init | head -5` 输出模板
- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/index.ts tests/cli.test.ts
git commit -m "feat(cli): serve / config / version subcommands"
```

---

### Task 13: 验收冒烟与 README 骨架

**Files:**
- Create: `README.md`
- Modify: `tests/integration/gateway.test.ts`（如 Task 10/11 有未覆盖分支补齐）

**Interfaces:** 无代码接口；交付验收证据。

- [ ] **Step 1: 跑全量测试**

Run: `bun test`
Expected: 全部 PASS（单测 + 集成，覆盖 spec §5 的 S1、S2、S3、S9、S10、S11、S12）

- [ ] **Step 2: 手动冒烟（可选，需真实 Key）**

```bash
O2A2O_UPSTREAM_ANTHROPIC=... # not needed if using real keys
cat > /tmp/o2a2o.yaml <<'YML'
server: { port: 8080, host: "127.0.0.1", log_level: "info" }
models:
  - name: "claude-sonnet-4-5"
    provider: "anthropic"
    api_keys: [{ key: "${ANTHROPIC_API_KEY}", priority: 1 }]
aliases: {}
api_keys: {}
YML
bun run src/index.ts serve --config /tmp/o2a2o.yaml
curl localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"reply with ok"}]}'
```
Expected: openai_chat 形状响应，choices[0].message.content 非空

- [ ] **Step 3: README**

骨架：项目一句话简介、M1 已支持/未支持（流式、多 Key、自动更新 → M2+）、快速开始（install/serve/curl 示例）、配置示例指向 `o2a2o config init`、链接 docs/REQUIREMENTS.md 与 docs/TECH-DESIGN.md。英文撰写。

- [ ] **Step 4: Commit**

```bash
git add README.md tests/integration/gateway.test.ts
git commit -m "docs: add readme with m1 scope and quickstart"
```

---

## Self-Review 记录

- **Spec 覆盖（M1 范围）**：FR-1/3/4/5/6（Task 4-6 转换器）✓；FR-7 错误映射（Task 8）✓；FR-8 多模态（image part 映射在 Task 5，text 必须/图片尽力——openai 侧 `mapContentParts` 在 Task 4 实现图片 url/base64 双形态）✓；FR-9/10 参数策略（Task 4 + dropped 头 Task 10）✓；FR-11 models（Task 11）✓；3.2 路由/别名/直通（Task 10）✓；3.4 动态 Key（Task 9）✓；3.8 鉴权（Task 3 校验 + Task 11 执行）✓；§4 CLI（Task 12）✓；S1-S3/S9-S12（Task 10/11/13）✓。M2+ 项（FR-2 流式、3.5 多 Key、3.6 动态超时、3.9 更新）显式出范围。
- **占位符扫描**：Task 4 chatToIr 代码块含两处行内注释标记实现意图（`/* mapped via disableParallelToolUse */`、`mapContentParts` 调用）——`mapContentParts` 需在实现时同文件补齐（openai content parts: `text/image_url`），属实现细节展开非 TBD；可接受。
- **类型一致性**：`ConvResult`/`ParamError` 定义于 Task 4（chat.ts），Task 5/6/8/10 均从 `./chat` 导入复用 ✓；`InputFormat`（Task 7）被 Task 8/10 消费 ✓；`GatewayOutcome.droppedParams` 与 server 的 `x-o2a2o-dropped` 头衔接 ✓。

## Final Review Corrections (2026-09-21)

- FR-2's `x-o2a2o-output-format` header was omitted from Tasks 10/11: the Self-Review mislabeled FR-2 as streaming, but FR-2 is the response-format override.
- Implemented in the final fix wave: `handleGatewayRequest` now reads and validates the header and renders the upstream response in the requested output format (raw only when it matches the native upstream shape, else upstream -> IR -> output-format converter).
- `o2a2o convert` (REQUIREMENTS §4) remains unassigned in this plan — carry to M2 planning.

## M2 Carry-Forward Backlog (from final review + task-review ledger, 2026-09-21)

Deferred by controller ruling — none block M1 merge; triage during M2 planning:

- Correctness follow-ups: `responsesResponseToIr` upstream `arguments` parse unguarded (malformed upstream → 500, responses.ts ~175); non-`true` stream values (`stream: 1` / `"true"`) bypass the M1 400 guard; anthropic-side URL-source images warn+skip, openai remote-URL image → anthropic renders `{source:{type:"base64",media_type:"url"}}` sentinel; `chatToIr` bare TypeError on tool_call missing `function`.
- Hardening: empty-string dynamic key wins resolveKey chain (`""` should fall through); `maskKey` reveals keys ≤ 12 chars; loader bare-catch maps EACCES→"not found", empty-YAML → TypeError, YAML syntax errors unwrapped, defaults-branch untested; 403 not classified as authentication; CLI invalid `--port` silently dropped, `--port 0` prints `:0`; config init template ships dead M2+ sections (`failover`/`timeout`/`update`) — comment out or feature-gate.
- Fidelity edges: cache_control on anthropic system blocks stripped but unrecorded in dropped; disableParallelToolUse lossy for forced tool_choice; `instructions` + system items both present → instructions dropped unrecorded; unknown `reasoning_effort` values dropped without warn/dropped entry; near-duplicate error-type mapping helpers.
- Test hygiene: restore `O2A2O_UPSTREAM_*` in afterAll; `authGw.stop` in try/finally; pin secondary `/v1/models` fields; reverse-direction 401 test; global-fallback + openai Bearer header assertions; forwarder env cleanup exception-safety.
- Features: `o2a2o convert` CLI command (unassigned); anthropic `/v1/models` `capabilities` field; DC-4 "attach gateway note" on structured-output upstream 400s; wire `server.log_level` through `setLogLevel` (currently dead; converters use raw console.*).

