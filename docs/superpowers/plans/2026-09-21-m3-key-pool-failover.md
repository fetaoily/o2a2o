# O2A2O M3 多 Key 池 + 故障转移 + 监控端点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 o2a2o v0.3：每模型多 Key 健康池（评分选优/冷却/渐进恢复）、跨 Key 故障转移重试（非流式 + 流式首包）、`GET /health/keys` 与 `POST /admin/keys/:keyId/reset` 监控端点，验收 S7 达成。

**Architecture:** `ApiKeyPool`（每模型一个池实例，状态机 healthy→cooldown→degraded→healthy，评分 = 优先级 + 权重 + 健康 + 延迟惩罚 + 连败惩罚 + 轮换奖励）替代 M2 的静态 resolveKey 选择；转发循环在可重试错误上换下一 Key（非流式整体重试；流式仅首包前可重试，D5 不变）；`LatencyTracker` 从按模型改为按键。全部离线可测。

**Tech Stack:** 不变（Bun + TS strict，零新运行时依赖）。

**Spec:** `docs/REQUIREMENTS.md`（§3.5 故障转移、§3.7 监控端点、验收 S7）+ `docs/TECH-DESIGN.md`（§7 Key 池设计：状态机/评分公式/行为规则——事实来源）+ M2 终审移交的 M3 项。

## Global Constraints（沿 M2，增量如下）

- M1/M2 全部约束继续有效（strict、无中文、Key 掩码不变量、conventional commit 单行无 Co-Authored-By）
- 评分公式（§7.2 已定）：`score = (100-priority)*10 + weight + healthBonus(healthy+1000/degraded+500/cooldown 0) - min(avgLatency/10, 500) - consecutiveFailures*100 + (lastUsed >60s 前 ? +50 : 0)`；取最高分
- 冷却：连续失败 ≥ `failover.failure_threshold`（默认 3）→ cooldown `failover.cooldown_ms`（默认 300000）；到期 → degraded；degraded 连续成功（默认 3 次）→ healthy（§7.1 状态机）
- 全部 Key 不可用时：兜底选 priority 最小者强制尝试（可用性优先，§7.3）
- 可重试错误（换 Key 重试）：网络错误、非流式整体超时、5xx、429、401/403（D4）；不可重试：400/422（直接返回客户端）、流式空闲/总时长超时（D5）
- 流式故障转移仅限**首包前**：first_packet 超时（retryable=true）换 Key 重发；首包到达后流已建立，任何失败不再换 Key（返回已生成部分/错误帧）
- 重试次数：`failover.max_retries`（默认 3）跨 Key 总尝试次数上限
- `LatencyTracker` 重构为按键维度（pool 内部持有），现有按模型调用点迁移；TimeoutCalculator 的按模型 avg 保留（模型级与 Key 级并存）
- M2 终审移交项清偿（本计划顺带）：stream 首包延迟写入 tracker（Key 维度）；incomplete reason `content_filter` → 映射 content_filter（不再落 stop）；convert 退出码路径补自动化测试

## 文件结构（本计划增量）

```
src/
├── core/
│   ├── api-key-pool.ts            # NEW 健康池: 状态机+评分+冷却+恢复 (纯逻辑,时钟可注入)
│   └── forwarder.ts               # MOD 故障转移循环 + pool 记账
├── config/{loader,validator,template}.ts  # MOD failover 节启用
├── core/models-endpoint.ts        # MOD keyId 解析辅助
├── server.ts                      # MOD /health/keys + /admin/keys/:keyId/reset 路由
├── core/unified-converter.ts      # MOD 重试循环接入两条路径
├── converters/stream-responses.ts # MOD incomplete content_filter 映射
tests/ 对应新增 api-key-pool.test.ts；forwarder/health 端点集成测试
```

---

### Task 1: failover 配置节启用 + validator 加固收尾

**Files:**
- Modify: `src/config/loader.ts`, `src/config/validator.ts`, `src/config/template.ts`
- Test: `tests/config/loader.test.ts`、`tests/config/validator.test.ts` 追加

**Interfaces:**
- Produces:
```typescript
export interface FailoverConfig {
  max_retries: number; failure_threshold: number; cooldown_ms: number;
  latency_window: number; recovery_successes: number;
}
// AppConfig 增加可选字段: failover?: FailoverConfig
export function resolveFailoverConfig(cfg: AppConfig): FailoverConfig;  // 默认 §6.1: 3/3/300000/10 + recovery_successes 3
```
- Backlog 清偿：validator 递归遇数组即报错（"timeout.<path>/failover.<path> must be a positive number" 同消息风格，治 M2 deferred 的数组形状漏洞）；补非数字叶拒绝的直接测试（`first_packet: "5000"`）。

- [ ] **Step 1: 失败测试**（loader：failover 缺省/显式加载 2 例；validator：数组拒绝、非数字叶拒绝 2 例）
- [ ] **Step 2: RED** → **Step 3: 实现**（模式与 M2 Task 1 的 resolveTimeoutConfig 完全同构：深合并默认值 + 递归正数校验 + 数组即错）→ **Step 4: GREEN 全套件** → **Step 5: Commit** `feat(config): failover section and validator hardening`

---

### Task 2: ApiKeyPool 核心（纯逻辑）

**Files:**
- Create: `src/core/api-key-pool.ts`
- Test: `tests/core/api-key-pool.test.ts`（新，本计划最重的单测文件）

**Interfaces:**
- Produces:
```typescript
export type KeyHealthStatus = "healthy" | "degraded" | "cooldown";
export interface KeyState {
  key: string; status: KeyHealthStatus; consecutiveFailures: number;
  totalFailures: number; lastFailureTime: number; lastUsedTime: number;
  avgLatency: number; latencySamples: number[]; cooldownUntil: number;
}
export interface KeyDecision { key: string; keyId: string; fallback: boolean }
export class ApiKeyPool {
  constructor(cfg: FailoverConfig, keys: ApiKeyConfig[], now: () => number = Date.now) {}
  select(): KeyDecision;                       // 评分选优; 全冷却时兜底 priority 最小 (fallback=true)
  recordSuccess(keyId: string, latencyMs: number): void;
  recordFailure(keyId: string): void;          // 连败达标 -> cooldown (until = now + cooldown_ms)
  maybeRecover(): void;                        // cooldown 到期 -> degraded; degraded 连续 recovery_successes 次 -> healthy
  snapshot(): Record<string, Omit<KeyState, "key">> & { keys: string[] };  // /health/keys 数据源, 掩码在端点层
}
```
- keyId = 掩码键（`maskKey(key)`）——端点 URL 与记账都用 keyId，明文 Key 永不出池。同 keyId 冲突时池构造抛 ConfigError（要求配置者区分 Key）。
- 评分与状态机严格按 Global Constraints；测试覆盖：评分排序（priority/weight/延迟/连败/轮换各分量独立判别）、冷却进入与到期、degraded 恢复计数、全冷却兜底、latency 窗口（failover.latency_window 截断）。

- [ ] **Step 1: 写失败测试**（约 12 例，逐分量判别——参考 M2 Task 2 修复轮的"区分力"标准，每个公式分量一个变异可检的用例；`now` 注入固定时钟，不睡真实定时器）→ **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN** → **Step 5: Commit** `feat(core): api key pool with scoring, cooldown and recovery`

---

### Task 3: 池集成 + 非流式故障转移循环

**Files:**
- Modify: `src/core/forwarder.ts`, `src/core/unified-converter.ts`, `src/config/loader.ts`（AppConfig 级池注册表挂载或构造传入——按现有 cfg 流转方式选择，报告说明）
- Test: `tests/core/forwarder.test.ts` 大幅追加

**Interfaces:**
- Produces:
```typescript
// forwarder.ts 重构
export class KeyPoolRegistry {                 // modelName -> ApiKeyPool (惰性构造, 全局单例注册)
  static from(cfg: AppConfig): KeyPoolRegistry;
  poolFor(model: ModelConfig): ApiKeyPool;
}
export async function forwardWithFailover(opts: {
  provider: Provider; endpoint: ...; body; registry: KeyPoolRegistry; model: ModelConfig;
  timeoutMs: number; maxRetries: number;
}): Promise<{ response: Response; keyId: string; fallback: boolean }>;
// 循环 max_retries 次: pool.select() -> forwardToUpstream -> 成功 recordSuccess 返回;
// 失败 recordFailure; 可重试分类 (网络/超时/5xx/429/401/403) 且未耗尽 -> 换 Key; 否则抛最后的 UpstreamError
```
- unified-converter 非流式路径改调 forwardWithFailover（timeoutMs 沿 M2 计算值）；`x-o2a2o-dropped`/错误渲染不变；UpstreamError 语义保持（最后一次失败的 status/body）。
- 测试：mock fetch 按调用次序返回失败/成功序列，断言 Key 切换次序（按池评分）、记账影响后续选择、重试耗尽抛最后错误、429/5xx/401 换 Key 而 400 不换。池状态跨请求持久（registry 复用）。

- [ ] **Step 1: 失败测试** → **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN 全套件（M2 的 140 测试是回归网）** → **Step 5: Commit** `feat(core): key pool integration and non-stream failover`

---

### Task 4: 流式首包故障转移

**Files:**
- Modify: `src/core/unified-converter.ts`（handleGatewayStream 的流建立段）
- Test: `tests/integration/gateway.test.ts` 追加

**Interfaces:**
- 行为：流建立 = fetch 返回 2xx 且**首包到达前**为可重试窗口。实现为「首包前重试环」：UpstreamError（headers 阶段失败）按 F3 同一循环处理；流建立后 StreamTimeoutManager 的 first_packet 超时（retryable=true）→ 关闭半开流、`recordFailure`、若预算内换下一 Key 重发整个请求（新 manager/新流）；首包到达后一切失败照 M2 语义（D5）。
- 重试期间不向客户端下发任何字节（首包未到，无部分结果）；重试耗尽 → 目标格式 error 帧 + 关流（消息含 "first_packet"）。
- 测试：慢上游 A（首包 500ms > 150ms 预算）+ 快上游 B → 客户端收到 B 的正常流（断言换 Key 发生：B 的 fixture 出现、A 的 socket 收到 close）；A+B 都慢 → error 帧后关流。

- [ ] **Step 1: 失败测试** → **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN** → **Step 5: Commit** `feat(gateway): stream first-packet failover across keys`

---

### Task 5: 监控与管理端点

**Files:**
- Modify: `src/server.ts`（两条新路由）, `src/core/models-endpoint.ts`（keyId 解析辅助）
- Test: `tests/core/models-endpoint.test.ts`、`tests/integration/gateway.test.ts` 追加

**Interfaces:**
- Produces:
```typescript
// server.ts
// GET /health/keys -> { timestamp, models: { [modelName]: { [maskedKeyId]: { status, consecutiveFailures, avgLatency, cooldownRemaining } } } }
// POST /admin/keys/:keyId/reset -> pool.resetKey(keyId): 状态归 healthy、连败清零、冷却清除; 未知 keyId -> 404
```
- 两端点受 auth_token 鉴权（M1 既有 gate 覆盖——验证即可）；掩码输出复用 maskKey；`cooldownRemaining = max(0, cooldownUntil - now)`。
- 测试：配置两 Key 并使主 Key 连败入冷却（短冷却配置）→ `/health/keys` 断言状态/剩余；reset 后状态归位、下一请求复用主 Key；未知 keyId 404；无 token 时 401。

- [ ] **Step 1: 失败测试** → **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN** → **Step 5: Commit** `feat(server): health and admin endpoints for key pools`

---

### Task 6: 移交项小批 + 文档收尾

**Files:**
- Modify: `src/converters/stream-responses.ts`（incomplete reason content_filter → 映射）, `src/cli.ts` convert 测试, README.md, TECH-DESIGN §20 勘误节
- Test: 对应追加

**Interfaces:**
- Backlog 清偿：(a) `response.incomplete` reason `content_filter` → IR `content_filter`（现落 stop）；(b) convert 的 `--to toString` exit-1 路径补自动化测试（runCli 层，临时文件 + 退出码断言）；(c) 流式首包延迟写入池的 recordSuccess（Task 4 顺带检查，漏则此处补）。
- README：M3 支持项（多 Key 故障转移/健康池/监控端点）、S7 示例；未支持收敛到 M4（自动更新+构建）。
- TECH-DESIGN：`## 20. M3 实现勘误（2026-09-21）`——记录实现期偏差（预期：评分常数微调、恢复策略实现细节），无则写 "none"。

- [ ] **Step 1: 失败测试 (a)(b)** → **Step 2: 实现** → **Step 3: GREEN 全套件** → **Step 4: 文档** → **Step 5: Commit** `feat(m3): carry-over batch and docs`

---

### Task 7: 验收终验

**Files:** 无新文件；运行 + 记录

- [ ] **Step 1: 全套件 + tsc**（记录精确数字；预期 ≥155 tests）
- [ ] **Step 2: S7 场景手动核验清单**（mock 级已覆盖；此步输出验收对照表进报告）——S7：主 Key 无效 → 请求仍成功（备用 Key 自动接管），`/health/keys` 可见主 Key 失败/冷却
- [ ] **Step 3: Commit**（如有遗留零星）`chore(m3): acceptance verification`

---

## Self-Review 记录

- **Spec 覆盖（M3 范围）**：§3.5 全项（多 Key/评分/冷却/恢复/兜底/重试分类/上限）= Task 2/3/4 ✓；§3.7 两端点 = Task 5 ✓；S7 = Task 4+5 集成测试 + Task 7 核验 ✓；M2 移交 M3 项（validator 数组/非数字叶、incomplete content_filter、convert exit-1 测试、stream 延迟入 tracker）= Task 1/6 ✓。M4 项（自动更新/五平台构建）显式出范围。M2终审 PARK 项（--port 归因、env 卫生、§8 by-reference、响应路径 dropped 通道）保持 PARK，不在本计划。
- **占位符扫描**：Task 2 测试"约 12 例"给出逐分量清单而非逐行代码——与 M1/M2 计划同颗粒度（测试意图 + 判别标准完整，公式与状态机在 Global Constraints 中逐字给出）；Task 3 registry 挂载方式留实现选择（报告说明）——两者均为受控展开非 TBD。
- **类型一致性**：`KeyDecision.keyId` 与端点 `:keyId` 参数一致（掩码即 ID）✓；`resolveFailoverConfig` 模式复刻 `resolveTimeoutConfig` ✓；`forwardWithFailover` 返回 `{response, keyId, fallback}` 供 unified-converter 记账与日志 ✓；FailoverConfig 数值与 §6.1 模板注释一致（recovery_successes 3 为 §7.1 恢复计数的落地字段）✓。
- **裁定**：keyId = 掩码（URL 安全且不泄漏明文；碰撞即配置错误，构造抛错）；流式重试期间零字节下发（首包前无部分结果）；池按模型分实例（M2 F1 教训：绝无跨流共享可变状态——池本身是共享可变状态，但其方法为同步临界区，事件循环内无 await 穿越状态变更，无需锁）。
