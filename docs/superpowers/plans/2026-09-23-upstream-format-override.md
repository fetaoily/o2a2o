# O2A2O 发现 4 修复：每模型 upstream_format 覆盖（纯 chat 上游承接 responses 入站）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-09-23 实机验收发现 4：`/v1/responses` 入站对"只会 chat completions"的 openai 系上游（智谱等）被同 provider 透传到上游 `/v1/responses` → 404。给模型加可选 `upstream_format: "chat"`，强制该模型的上网线材格式，responses 入站自动经 IR 转换为 chat。

**Architecture:** `ModelConfig.upstream_format?: "chat"`（仅 openai provider 模型可设；缺省 = 现行为逐字节不变）。设置后 resolveRoute 的「同 provider 透传」分支对该模型不生效：responses 入站走 `TO_IR[openai_responses]` → `irToChat`（既有转换器），endpoint 固定 `/v1/chat/completions`；`nativeFormatOf` 同步尊重该覆盖（响应解码与流式 srcFormat 均按 openai_chat）。流式方向 chat-SSE → responses-SSE 的转换器 M2 已有。

**Tech Stack:** 不变。

**Spec:** 用户确认的修复方案（2026-09-23 会话）+ `docs/TECH-DESIGN.md` §22 + `src/core/unified-converter.ts` resolveRoute/nativeFormatOf（:121-148 逻辑核心）。

## Global Constraints

- 全部既有约束继续有效（strict、无中文、离线测试、bullet commit、无 Co-Authored-By）
- 缺省行为逐字节不变（既有 285 测试全绿是回归网）
- 上游格式覆盖仅开放 `"chat"`（`"responses"` 与 anthropic provider 上设置 → ConfigError，附清晰消息；irToResponsesRequest 请求编码器尚不存在，等真实上游需要再加——YAGNI 裁定）
- base_url（Task 2 批次）与本字段正交可叠加；客户端中止语义（Task 1 批次）不受扰

## 文件结构

```
src/config/{loader,template}.ts   # MOD upstream_format 字段 + 校验 + 注释示例
src/core/unified-converter.ts     # MOD resolveRoute 透传分支 + endpoint + nativeFormatOf
README.md / docs/TECH-DESIGN.md   # MOD 文档 + §22
tests/config/loader.test.ts、tests/integration/gateway.test.ts  # MOD
```

---

### Task 1: upstream_format 覆盖

**Interfaces:**
- Produces:
```typescript
// loader.ts
interface ModelConfig { /* 既有 */ upstream_format?: "chat" }
// 校验: 仅 openai provider 模型可设; 值仅 "chat"; 其余 -> ConfigError(带字段路径)
// unified-converter.ts
// resolveRoute: model.upstream_format === "chat" 且 format === "openai_responses"
//   -> 走 IR 转换(同既有 anthropic->openai 路径), endpoint = /v1/chat/completions
// nativeFormatOf 尊重覆盖 -> 响应解码与流 srcFormat 按 openai_chat
```
- 测试（判别性）：校验正负 3 例；集成：mock 上游（自定义无 /v1 路径，同智谱形态）+ `upstream_format: "chat"` → responses 入站（含 `max_output_tokens`/`input`）上游收到 chat 体（断言 path + body 形态），客户端收到合法 responses 输出（`output_text`）；流式：上游收 chat SSE、客户端收 responses 事件帧；缺省行为逐字节不变（对照：无覆盖时 responses 入站仍透传 /v1/responses——既有断言继续成立）。

- [ ] TDD → Commit `feat(config): per-model upstream_format override for chat-only openai upstreams`

---

## Self-Review 记录

- **覆盖**：发现 4 全项 = Task 1 ✓。M1 同 provider 透传语义对未设置模型零变化 ✓。
- **占位符扫描**：无。chat→responses 的 SSE 转换器存在性属实现期核验（M2 交付全 6 方向，缺则升格为发现）。
- **类型一致性**：`"chat"` 单值枚举与 irToChat 既有出站编码器对齐 ✓。
- **裁定**：仅开放 "chat"（irToResponsesRequest 不存在，YAGNI）；anthropic provider 禁设（避免 auth 头语义歧义）；流式 srcFormat 跟随覆盖（nativeFormatOf 单点修改）。

## Final Review Corrections (recorded post-execution)

- Task review found one Important (test-hardening, code correct): the `&& format === "openai_responses"` clause guarding chatOverride was mutation-unguarded — dropping it would silently IR-round-trip chat inbound requests and strip 13+ passthrough params via the DROPPED list with only a warn. Fixed in fix round 1 (801bcd0): one discriminating integration test (chat inbound + presence_penalty to an override model asserts the untouched body at the chat path and no dropped header); implementer performed a real mutation check (dropping the clause fails exactly this test).
- Deferred: absent-override byte-identical control exists streaming-only (non-stream control is implied by the override test's mirror).
- chat→responses SSE conversion needed no new code — the M2 convertStream hub (parseChatChunk → ResponsesStreamEncoder) already covered the direction.
