# O2A2O 实测加固批次：客户端断开处理 + 每模型 base_url + 非流式延迟记账

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-09-23 智谱实测发现的三个问题：(1) 客户端中途断开时网关继续向死套接字泵数据——触发 Bun 1.3.7 原生段错误（双流并发中止必崩）且白烧上游 token；(2) openai 路由硬拼 `/v1/` 前缀，无法指向智谱等无 `/v1` 段的 OpenAI 兼容上游；(3) 非流式成功不喂延迟样本，`/health/keys` 的 `avgLatency` 恒为 0。

**Architecture:** (1) 把 `req.signal` 贯穿 server → 两条网关路径 → `forwardToUpstream` 的超时 AbortController；客户端中止 = 取消上游 fetch + 停泵 + **不做 Key 故障记账、不做跨 Key 重试**（客户端行为不是上游故障）；取消沿既有传播链（输出流 cancel → inner reader → stream-converter → 上游 body）自然抵达上游。(2) `models[].base_url`（可选，SDK 约定：含版本段，追加方法段路径）；优先级 `model.base_url > O2A2O_UPSTREAM_* env > provider 默认`，env/默认保持 origin 语义不变。(3) 非流式循环按尝试测量上游响应头耗时喂 `pool.recordSuccess`。

**Tech Stack:** 不变（Bun + TS strict，零新运行时依赖）。

**Spec:** 实测报告（本会话 2026-09-23）+ `docs/TECH-DESIGN.md`（§7 Key 池、§8 超时、§11 流）+ `src/core/unified-converter.ts`（D4/D5 语义注释）。崩溃报告：https://bun.report/1.7.3/wr1ba42621gCghooC4kukvDglh6V8yxqe__g5govCA2DD （1.3.7）。

## Global Constraints

- M1-M4 全部约束继续有效（strict、生成代码无中文、Key 掩码不变量、conventional commit 单行、正文 bullet list、无 Co-Authored-By）
- 全部测试离线：本地 Bun.serve mock，禁 api.github.com / 外网
- **客户端中止语义（本计划核心裁定）**：client abort ≠ 上游故障。不 `recordFailure`（不毒化 Key 健康）、不触发 failover 换 Key、不计入 max_retries；唯一动作 = 尽快取消上游 + 停止向客户端写
- **base_url 语义裁定**：`models[].base_url` 为「含版本段的完整前缀」，追加方法段（`/chat/completions`、`/responses`、`/messages`，即现有 endpoint 去掉 `/v1` 前缀）。例：智谱 chat = `https://open.bigmodel.cn/api/paas/v4`。env 覆盖与默认值的 origin 语义（+`/v1/<method>`）**不变**
- 延迟语义：两条路径统一为「上游响应头到达耗时」（流式既有 first_packet 同口径）
- Bun 原生崩溃无法在 CI 断言「不崩」——CI 可验证的是机制契约（取消被上游观察到 / 不重试 / 不记账）；双流中止存活验证属合并后实机验收（控制器执行）

## 文件结构（本计划增量）

```
src/
├── server.ts                      # MOD 传 req.signal 进两条路径
├── core/
│   ├── forwarder.ts               # MOD signal 组合进超时 controller + baseUrl 解析 + 非流式延迟测量
│   └── unified-converter.ts       # MOD signal 贯穿两条路径 + 建流阶段中止即整单终止
tests/
├── core/forwarder.test.ts         # MOD signal/baseUrl/延迟 单测
├── core/disconnect.test.ts        # NEW 断开语义集成测试（本地 Bun.serve）
├── config/loader.test.ts          # MOD base_url 校验
└── integration/gateway.test.ts    # MOD base_url 端到端
```

---

### Task 1: 客户端断开处理（P0 崩溃缓解）

**Files:**
- Modify: `src/server.ts`, `src/core/forwarder.ts`, `src/core/unified-converter.ts`
- Test: `tests/core/disconnect.test.ts`（新）, `tests/core/forwarder.test.ts` 追加

**Interfaces:**
- Produces:
```typescript
// server.ts: fetch handler 传 req.signal
handleGatewayRequest(cfg, path, body, headers, signal?: AbortSignal)
handleGatewayStream(cfg, path, body, headers, signal?: AbortSignal)
// forwarder.ts
forwardToUpstream({ ..., signal?: AbortSignal })   // 与超时 controller 组合；优先探测 AbortSignal.any（运行期一行验证并记录报告），否则手动 addEventListener({once:true}) + finally removeEventListener
forwardWithFailover({ ..., signal?: AbortSignal }) // signal.aborted -> 不重试不记账直接抛 AbortError
// unified-converter.ts
establishUpstreamStream({ ..., signal?: AbortSignal })
// 建流阶段 abort: 取消在飞上游 fetch、唤醒 settled、循环检测 aborted 即整体终止（返回空闭流 outcome，不渲染错误帧——客户端已不在）
// 建流后 abort: monitor.disarm() + reader.cancel() + outController 安全关闭 + 监听器清理（pull done / cancel / error 三条路径都要清）
```
- 语义钉子（逐条测试）：
  1. 非流式中止：mock 上游（本地 Bun.serve）观察到自身 `request.signal` aborted；网关进程存活可继续服务；池无 recordFailure（`/health/keys` totalFailures 不变）
  2. 建流阶段中止：上游 headers 挂起时客户端 abort → 恰好 1 次上游尝试（无换 Key）、无错误帧渲染需求、无池记账
  3. 建流后中止：流中途 abort → 转换链 reader 取消、上游 body 取消（mock 观察到）、监听器清理后连接正常关闭
  4. 超时 abort（既有）与客户端 abort 分类互不串扰：超时仍走重试/记账，客户端中止不走

- [ ] TDD：失败测试 1-4 → 实现 → GREEN 全套件 → Commit `feat(gateway): client disconnect cancels upstream without key accounting`

### Task 2: 每模型 base_url

**Files:**
- Modify: `src/config/loader.ts`（ModelConfig 增可选 `base_url?: string` + 校验：http(s) URL、去尾斜杠、拒 query/hash）, `src/config/template.ts`（注释示例，给智谱）, `src/core/forwarder.ts`（URL 解析）, `src/core/unified-converter.ts`（resolveRoute 的 model 已在 return，转发调用点透传 baseUrl）
- Test: `tests/config/loader.test.ts`, `tests/core/forwarder.test.ts`, `tests/integration/gateway.test.ts` 追加

**Interfaces:**
- Produces:
```typescript
// loader.ts
interface ModelConfig { /* 既有 */ base_url?: string }
// forwarder.ts
resolveUpstreamUrl(opts: { provider: Provider; endpoint: GatewayEndpoint; baseUrl?: string }): string
// baseUrl 存在: normalize(baseUrl) + methodPath(endpoint)（methodPath = endpoint 去掉前导 "/v1"）
// 否则: upstreamBase(provider) + endpoint（现行为逐字节不变）
```
- 转发调用点（非流式 :173-176、建流 :233-236）从 `model.base_url` 透传。
- 测试：校验正负例；三 endpoint × base_url 的 URL 构造（mock 断言收到的 path，含智谱形态 `/api/paas/v4/chat/completions`）；base_url 缺省时 env 与默认值行为逐字节不变；端到端：mock 上游挂自定义无 `/v1` 路径 → 网关打通。
- README：models 节补 `base_url` 文档 + 智谱示例；TECH-DESIGN §22 勘误记语义裁定。

- [ ] TDD → Commit `feat(config): per-model base_url for non-v1 upstream prefixes`

### Task 3: 非流式延迟记账

**Files:**
- Modify: `src/core/forwarder.ts`（forwardWithFailover 内按尝试测量）, `src/core/unified-converter.ts`（如流式调用点口径核对）
- Test: `tests/core/forwarder.test.ts`, `tests/integration/gateway.test.ts` 追加

**Interfaces:**
- 语义：每次尝试 t0 = fetch 前；2xx 到达 → `pool.recordSuccess(keyId, Date.now() - t0)`（响应头口径，与流式 first_packet 同一）。动态 Key 路径零记账（现状不变）。
- 测试：mock 上游延迟 ~30ms → 请求后 `/health/keys` avgLatency > 0（集成）；单测断言 recordSuccess 收到测量值（注入时钟或延迟 mock）。
- TECH-DESIGN §22 补一行延迟口径。

- [ ] TDD → Commit `feat(core): feed non-stream upstream latency into key pool scoring`

---

## Self-Review 记录

- **覆盖**：实测发现 1 = Task 1；发现 2 = Task 2；发现 3 = Task 3 ✓。M4 遗留 backlog（plist 日志目录、resolveKeyId catch-all 等）明确不在本计划。
- **占位符扫描**：AbortSignal.any 可用性留运行期探测并记录（实现细节非设计缺口）；其余接口/语义均已给出精确值。
- **类型一致性**：`signal?: AbortSignal` 逐层可选透传（server 为唯一必源头）；`resolveUpstreamUrl` 的 endpoint 类型与现有 forwardToUpstream 一致；base_url 优先级不改 env 语义 ✓。
- **裁定**：客户端中止零记账零重试（防 Key 健康被客户端行为污染）；建流阶段中止整单终止不渲染错误帧；base_url 用 SDK 约定而非改 env 语义（零破坏）；CI 只断言机制契约，崩溃存活属实机验收。

## Final Review Corrections (recorded post-execution)

Whole-branch review (4e6bd38..1a4c79a, 3 commits) verdict: READY TO MERGE, zero Critical/Important. Resolutions and facts worth keeping:

- **Finding 3 was a false alarm**: the non-stream latency feed has existed since M3 (498fdbb, `forwardWithFailover` feeds `Date.now() - start` on 2xx). The live `avgLatency: 0` was a test-ordering artifact — `/health/keys` was queried as the first request in a freshly restarted process, so the pool had zero samples. Task 3 landed as mutation-verified pinning tests + a TECH-DESIGN §22 latency-semantics line; no production change.
- **All three rulings verified surviving integration** (not merely plausibly): the abort check is ordered before failure classification at every decision site in both forward paths and both stream phases, so a client abort can never reach the retryable-AbortError branch, consume retries, or touch key health; the composed signal never marks the client signal, making timeout/abort cross-contamination structurally impossible.
- **Adversarial evidence beyond CI**: the reviewer ran 5 rounds of two parallel aborted SSE streams against the real gateway — 10/10 upstream body cancels observed, zero crashes (this was the exact deterministic segfault shape from the original incident). Empirically, on Bun the composed signal also cancels an in-flight `res.json()` mid-body, so the headers→json "gap" exists only on the unused manual fallback path.
- **Deferred minors (next batch fodder)**: pin the dual-abort crash shape as a CI test; log the resolved upstream URL at debug level so a mistyped `base_url` is traceable; label client-abort distinctly in the failure warn line; adopt the `GatewayEndpoint` alias; trailing `?`/`#` rejection in base_url validation (currently a loud upstream 404, never silent); non-array `models` error-message polish.
- **Update/RC-release path untouched**: `git diff 4e6bd38..1a4c79a -- src/update scripts .github package.json` is empty.
