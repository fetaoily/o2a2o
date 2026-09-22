# O2A2O M4 自动更新 + 原生安装包 + RC 发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 o2a2o v0.3.0-rc.1：`o2a2o update` 自更新（GitHub Releases 源、SHA256、备份/原子替换/回滚）、五平台编译产物、**原生系统安装包**（Windows/Linux/macOS 按输出形态对齐 udpshunt、工具按本项目合理选型）、**RC 版发布到 GitHub Releases（prerelease 标记，正式版不发布）**。

**Architecture:** UpdateManager = 版本检查（GitHub API + semver）→ 资产下载 → SHA256 校验 → 备份 → 原子替换（Windows 用 rename 策略：运行中 exe 不能覆盖/删除但可重命名）→ 自验证 → 失败回滚。打包：`bun build --compile` 五平台二进制 + 平台安装器（Windows NSIS 或 zip+安装脚本【按工具可用性spike定】；Linux nfpm 产 deb/rpm + systemd 单元；macOS tarball + launchd plist）。发布：`gh release create --prerelease` 附 checksums。

**Tech Stack:** Bun + TS（不变）；nfpm（单文件二进制， Linux 包）；NSIS 或 PowerShell 安装脚本（Windows，spike 定）；`gh` CLI（发布）。

**Spec:** `docs/REQUIREMENTS.md`（§3.8 自动更新、CLI `o2a2o update`）+ `docs/TECH-DESIGN.md`（§11 更新流程、§6.1 update 配置节）+ M3 终审移交 M4 项。**用户增量需求（2026-09-22）：(1) RC 版发布测试授权（prerelease；正式版不发）；(2) 打包目标 = 原生系统安装包（输出形态对齐 udpshunt，工具自选）。**

## Global Constraints（沿 M3，增量如下）

- M1-M3 全部约束继续有效
- **发布边界（用户明确授权范围）**：允许 `gh release create --prerelease` 发布 RC；**禁止**发布非 prerelease 的稳定版、禁止 `git push`（tag/分支推送如发布流程必需，属于发布原子的组成部分，仅在本计划 RC 发布任务中允许推 tag——这是用户"发布rc版"指令的直接蕴含；除此之外任何 push 仍禁止）
- 更新原子性：下载到 `<binary>.new` → SHA256 → 备份 `<binary>.backup` → Windows: `rename(current→current.old)` + `rename(new→current)`（运行中 exe 不可覆盖但可重命名）；POSIX: 直接 rename；自验证 `--version` 失败 → 从备份回滚
- 更新源：`https://api.github.com/repos/fetaoily/o2a2o/releases`（含 prerelease 判定：RC 测试期更新应能收到 rc 版本——`update.allow_prerelease` 配置，默认 true，RC 期语义）
- 配置节 `update:` 从模板注释态启用：`{ enabled: true, repo: "fetaoily/o2a2o", check_on_start: true, allow_prerelease: true }`
- M3 终审移交项清偿（顺带）：counting 字段 Integer 校验；fallback 测试 key 序交换；healthKeysBody catch 按类型区分；failover validator 负测试

## 文件结构（本计划增量）

```
src/
├── update/
│   ├── update-manager.ts        # NEW 检查/下载/校验/替换/回滚 (可注入 fetch+fs 根)
│   └── github-releases.ts       # NEW GitHub API 客户端 (list/asset download)
├── cli.ts                       # MOD update 子命令 + config update 接线
├── config/{loader,validator,template}.ts  # MOD update 节启用 + Integer 校验
└── index.ts                     # MOD (不变或启动检查接线)
scripts/
├── build-all.mjs                # NEW 五平台 compile + checksums
├── package-win.mjs|nsi          # NEW Windows 安装器 (spike 定)
├── package-linux.mjs            # NEW nfpm deb/rpm + systemd unit
├── package-macos.mjs            # NEW tarball + launchd plist
└── release-rc.mjs               # NEW tag + gh release create --prerelease
packaging/                       # NEW 安装器资源 (nsi/nfpm.yaml/plist/单元文件)
tests/update/                    # NEW
```

---

### Task 0（spike，纳入 Task 1）: 打包工具可用性审计

Task 1 的 Step 0：探测本机/CI 可用工具并**记录裁定**——`makensis`（NSIS）可用性；`nfpm` 获取途径（scoop/go install/直接下载单文件）；`gh auth status` 与 api.github.com 连通性。每个探测点产出「采用/回退」结论写进报告：Windows 安装器采用 NSIS，不可用则回退 zip+install.ps1（PS 脚本做复制+可选服务注册）；deb/rpm 采用 nfpm，不可用则回退 tar.gz+systemd 单元文件。**回退路径即最终交付**，不因工具缺失阻塞。

### Task 1: 版本管理基座 + 工具审计

**Files:**
- Create: `scripts/build-all.mjs`, `scripts/update-env-probe.mjs`（spike 脚本，一次性，完成后可删）
- Modify: `package.json`（version → 0.3.0，scripts：build:all/checksums）
- Test: `tests/smoke.test.ts` 追加 version 断言

**Interfaces:**
- Produces: `bun run build:all` 产出 `dist/o2a2o-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,windows-x64.exe}` + `dist/checksums.txt`（sha256sum 格式，`--target` 由 bun 原生支持）；`o2a2o version` 打印 0.3.0。
- spike 结论记录到报告（Task 2/3 依赖）。

- [ ] **Step 0: spike**（探测 + 裁定记录）→ **Step 1: version 测试 RED** → **Step 2: 实现 bump + build 脚本** → **Step 3: build:all 实跑验证五产物 + checksums** → **Step 4: GREEN** → **Step 5: Commit** `feat(build): five-platform compile and version 0.3.0`

### Task 2: UpdateManager 核心

**Files:**
- Create: `src/update/github-releases.ts`, `src/update/update-manager.ts`
- Test: `tests/update/update-manager.test.ts`（新；本地 Bun.serve mock GitHub API + mock 资产服务；真实 fs 于临时目录）

**Interfaces:**
- Produces:
```typescript
export interface ReleaseInfo { version: string; prerelease: boolean; assetUrl: string; sha256Url?: string }
export async function fetchLatestRelease(repo: string, opts: { allowPrerelease: boolean; fetchFn? }): Promise<ReleaseInfo | null>;  // null = 已最新
export class UpdateManager {
  constructor(opts: { repo: string; currentVersion: string; binaryPath: string; allowPrerelease: boolean; fetchFn?; now? }) {}
  check(): Promise<ReleaseInfo | null>;                       // semver 比较 (rc < 正式: 0.3.0-rc.1 < 0.3.0)
  update(rel: ReleaseInfo): Promise<{ ok: boolean; rolledBack: boolean }>;  // 下载→sha256→备份→原子替换→自验证→回滚
}
```
- 自验证 = spawn `binaryPath --version`，exitCode !== 0 或输出不含期望版本 → 回滚。Windows 路径走 rename 策略（TECH-DESIGN §11）。
- 测试：新版本/同版本/prerelease 过滤、下载校验失败→中止、替换后自验证失败→回滚（断言原二进制内容恢复）、Windows rename 分支（在 win32 上即真实路径）。

- [ ] TDD 全循环 → Commit `feat(update): update manager with atomic replace and rollback`

### Task 3: `o2a2o update` CLI + 启动检查

**Files:**
- Modify: `src/cli.ts`（update 子命令：check + 确认提示非交互默认执行 + 结果输出）, `src/config/{loader,template}.ts`（update 节启用）, `src/index.ts`（check_on_start 时后台检查打印提示，不阻塞）
- Test: `tests/cli.test.ts`、`tests/update/` 追加

**Interfaces:** `parseArgv` 增 `{ cmd: "update" }`；`update.enabled === false` 时 update 命令打印 disabled + exit 1；check_on_start 只提示不自动执行替换。
- [ ] TDD → Commit `feat(cli): o2a2o update command and startup check`

### Task 4: 原生安装包

**Files:**
- Create: `packaging/`（nsi 或 install.ps1 / nfpm.yaml / o2a2o.service / launchd plist）+ `scripts/package-*.mjs`
- Modify: `package.json` scripts（package:win/linux/mac/all）
- Test: 打包为脚本型任务——验证方式 = 实跑产物存在性 + 结构断言（deb 系内文件清单、nsi 产物存在、tarball 内容清单），写入 `tests/packaging.test.ts`（跳过条件：平台不匹配的工具跳过对应断言）

**Interfaces:**
- 产物（RC 资产集）：`o2a2o_v0.3.0-rc.1_{windows-x64-setup.exe|windows-x64.zip}`、`o2a2o_v0.3.0-rc.1_linux-{amd64,arm64}.deb`、`_linux-{amd64,arm64}.rpm`、`_linux-{amd64,arm64}.tar.gz`、`_macos-{arm64,x64}.tar.gz`（按 spike 裁定裁剪）
- Linux 包内容：二进制 → `/usr/local/bin/o2a2o`，`o2a2o.service`（simple 服务，EnvironmentFile 可选）→ `/etc/systemd/system/`
- Windows：exe → 安装目录 + 可选 PATH 注册（安装脚本/NSIS 内）
- [ ] 实现 + 实跑断言 → Commit `feat(build): native installers for windows linux macos`

### Task 5: RC 发布

**Files:**
- Create: `scripts/release-rc.mjs`（tag `v0.3.0-rc.1` → push tag → `gh release create --prerelease --title --notes` 附 dist 资产 + checksums）
- Modify: `package.json`（script `release:rc`）

**Interfaces:** 幂等保护（tag 已存在 → 明确报错不覆盖）；发布前强校验：全套件绿 + checksums 与产物一一对应 + 版本一致性（package.json = tag）。
- **网络失败路径**：gh/network 失败 → 报告 BLOCKED-partial（产物与脚本已就绪，发布命令留待网络恢复后一条命令重试）——不阻塞后续任务。
- [ ] 校验 → 实发布（或 BLOCKED-partial 记录） → Commit `feat(release): rc release automation`

### Task 6: M4 移交批 + 文档

**Files:**
- Modify: `src/config/validator.ts`（Integer 校验：max_retries/failure_threshold/latency_window/recovery_successes + timeout 计数类字段）、`tests/core/api-key-pool.test.ts`（fallback 测试 key 序交换）、`src/core/models-endpoint.ts`（healthKeysBody catch 按错误类型区分：ConfigError → warn + 空 entry 保留；其他错误 → 上抛）、`tests/config/validator.test.ts`（failover 负测试）、README、TECH-DESIGN §21 勘误
- Test: 对应追加

- [ ] TDD → Commit `feat(m4): carry-over batch and docs`

### Task 7: 验收终验

- [ ] 全套件 + tsc + `build:all` + 安装器产物清单 + RC Release 存在性核验（gh release view --json isPrerelease,assets）→ 报告验收对照表 → Commit（如有零星）

---

## Self-Review 记录

- **Spec 覆盖（M4 范围）**：§3.8 全项（检查/提示/update 命令/SHA256/备份/原子替换/自验证回滚）= Task 2/3 ✓；五平台构建 = Task 1 ✓；原生安装包（用户增量）= Task 4 ✓；RC 发布（用户增量，prerelease 边界）= Task 5 ✓；M3 移交 4 项 = Task 6 ✓。发布边界裁定（RC-only、tag-push 仅限发布原子）已入 Global Constraints。
- **占位符扫描**：Task 0 spike 结论决定 Task 4 具体工具——属计划内置的探测-回退结构（回退路径即交付），非 TBD；Task 5 网络失败路径显式定义。
- **类型一致性**：ReleaseInfo 在 T2 定义、T3/T5 消费 ✓；UpdateManager opts 含 fetchFn 注入（mock 测试）✓；build:all 产物命名与 release-rc 资产引用一致（v 前缀版本化）✓。
- **裁定**：RC 期 allow_prerelease 默认 true；tag push 仅在发布任务内且属用户 RC 发布指令蕴含；Windows 安装器回退链 NSIS→zip+ps1；Linux 回退链 nfpm→tar.gz+unit。

## Final Review Corrections (recorded post-execution)

The M4 whole-branch final review (e87e473..afbbc45) found the release pipeline fails deterministically on first use — it had never been exercised end-to-end — plus two update-command hazards. Fix wave afbbc45..11da624 (d2cede0, 11da624), scoped re-review CLEAN:

- **Per-platform installer checksums (Critical)**: only `package-all.mjs` wrote `dist/installers/checksums.txt`; CI runs `package:<platform>` per job, so the release job's merge step `cat dist-*/installers/checksums.txt` matched nothing and would die before `gh release create`. Fixed via a shared `scripts/lib/checksums.ts` helper called by each per-platform script (1+6+2 = 9 installer lines + 5 binary lines = the workflow's 14-line hard assert); exact-byte format pinned by tests.
- **Version-true RC scheme (Critical, supersedes the Task 0-era "append -rc.1" ruling)**: the tag `v0.3.0-rc.1` implied release version `0.3.0-rc.1` while binaries baked `0.3.0`, so every RC self-update failed self-verify and rolled back, and semver ordering made the RC iteration channel inert. The repo version now IS the release version: `package.json` carries `0.3.0-rc.1` during the RC period, tag and asset names derive verbatim (`v${version}`), every hardcoded `-rc.1` was removed, tests derive expected names from package.json, and an invariant test pins the tag derivation against suffix drift.
- **Intentional version output**: the `--version` flag was previously unhandled (argv fell through to `help`; self-verify passed only via the usage text's first line, by accident). `parseArgv` now maps `version`/`--version`/`-v` and the command prints `o2a2o <semver>` — self-verify is correct by design.
- **Update identity guard (Important)**: under `bun run src/index.ts update`, `process.execPath` is the bun runtime — an update would have overwritten the developer's bun install. An identity-only pre-check now runs before anything is touched (`--version` stdout must contain `o2a2o`); version equality is deliberately NOT required so an older o2a2o binary can legitimately update.
- **Config fallback + throw guard (Important)**: `o2a2o update` no longer hard-requires a loadable `./o2a2o.yaml` — on config-load failure it prints a notice and uses the update-section defaults via the `resolveUpdateConfig` single source; the previously unguarded `await manager.update` now renders `update failed: <err>` and exits 1 instead of rejecting.
- **Workflow hardening (ride-along)**: `permissions: contents: write` scoped from workflow level to the release job only; placement pinned by test.
- **Deferred triage (adopted from the final review)**: Task 1/Task 2 minor groups PARK; Task 3 group implemented in this wave; Task 4 group split (plist log dir DEFER, rest resolved or PARK); Task 5 group mostly DEFER (permissions scoping done here); Task 6 group DEFER (`a10f4a3` verified benign). Post-re-review minors DEFERRED: the `-rc.1` ban in `tests/release-rc.test.ts` is a deliberate file-wide tripwire (comments included); `--version`/`-v` aliases not yet listed in `printUsage`/README usage block (future docs pass).
- **Release verification**: the pipeline was exercised end-to-end on CI by pushing a disposable `v0.3.0-rc.0` tag first (within the user-authorized RC prerelease scope; deleted after verification), then the deliverable `v0.3.0-rc.1`. Suite at merge: 260/260, `bunx tsc --noEmit` clean.
