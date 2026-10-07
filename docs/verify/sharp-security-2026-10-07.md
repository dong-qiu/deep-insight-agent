# sharp / librsvg 安全修复验证收据

## 身份与范围

- 启动基线：`b407b9e61915c33f835966f8f760f3424f0e17f5`（#423 的 source-map-js 修复已合并）。
  中间基线：`5539ec136ca8a087f190670332bae87db5bfdbbe`（#426）和
  `1bf16e4bb75e9fb04dcc70f9d15ccbdc14b5bb24`（#360）；最终基线：
  `origin/main` @ `cc837b1fc17ca3b990430a4874461f935d64b5f1`（接纳 #428 两份文档，满足 strict up-to-date）。
- 独立分支：`fix/sharp-security-complete-20261007`；独立 linked worktree；仅复制 `.env.local`，
  权限 0600，DATA_DIR / DB_PATH 已隔离。未复制生产数据、SQLite/WAL、报告、备份或 `.env.development.local`。
- 现场主工作区的已有未提交文件、共享 roadmap / ADR 和其他 worktree 保留。#426 由另一会话合并，
  本次只快进自己的隔离分支接纳新主干，没有操作或改写该 PR。
- 验收：[sharp-security spec](../plan/specs/sharp-security.md)。只做 sharp 修复；不夹带 graph smoke、D7 S2、
  prompt/模型/来源/引用规则变化，不合并、部署或清理。

## 公告、来源与依赖调查

- [官方公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)：
  GHSA-wq5f-xc86-pv6w / CVE-2026-96889，high，受影响 sharp `<0.35.5`；修复 `>=0.35.5`。
  上游描述 librsvg 内存问题，特定运行条件下 glibc Linux 可能 RCE；全局 librsvg 也须更新到 2.63.2。
- [GitHub 公共公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) API `published_at`：
  `2026-10-06T13:43:57Z`；厂商公告日期 2026-09-30。公共数据库收录晚于 #423 PR CI
  [37461293268](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37461293268) 的成功完成时间
  `2026-10-06T12:15:30Z`。#423 合并后的精确主干
  [CI 37501620737](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737) 因此 audit 失败；
  不能用此前 PR CI 代替主干当前状态。
- [sharp 0.35.5 release](https://github.com/lovell/sharp/releases/tag/v0.35.5)：
  发布 `2026-09-27T13:44:22Z`；npm registry 发布时间 `2026-09-27T13:46:24.509Z`。
  [libvips 包 1.3.4 release](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)：
  `2026-09-27T12:08:57Z`，官方依赖表列出 librsvg 2.63.2 / libvips 8.18.7。
- 包来源：`lovell/sharp` 与 `lovell/sharp-libvips` 官方仓库；所有 27 个变化条目的 `resolved` 和
  `integrity` 都逐一与 npm registry 对应版本核对一致。sharp tarball
  `https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz`，integrity：
  `sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==`。
- `npm explain sharp` / `npm ls sharp source-map-js --all`：生产 Next 16.3.8 的 optional 依赖 sharp，
  声明 `^0.35.4`；启动基线根 override 精确固定 0.35.4，最终基线已固定 0.35.5。
  不是纯开发依赖；optional 不表示没有运行风险。
  安装图仅一份 sharp；source-map-js 仍为 1.2.2，magicast 仍使用 #423 的正式 vendor 补丁。

## 最小补丁与行为边界

最终候选共五个文件：`ops/sharp-security.node-test.mjs`；`.github/workflows/ci.yml` 添加一项 Docker
原生解码检查；`Dockerfile` 显式复制已安装的 `@img` 平台闭包；专属 spec 与本收据。
当前完整 diff 不再修改 package 文件。

从启动基线独立定向更新时，锁图结构比较确认仅 27 个 sharp 闭包条目变化：sharp / @img sharp binding 与 WASM 包
0.35.4 → 0.35.5，平台 libvips 包 1.3.3 → 1.3.4。没有 Next、Vitest、semver、detect-libc、
@img/colour 等无关升级，没有残留旧 sharp 副本或本地路径泄漏。PostCSS override 与全部 vendor 补丁保持。
定向命令：`npm update sharp --package-lock-only --ignore-scripts --no-audit`；随后正常 `npm ci` 与全依赖 audit。
并行会话合并 #426 后，核验其两份 package 文件与本次定向修复内容一致，最终候选以新主干为基线，
仅补充保护和证据。不反向回退其 graph smoke，保留自己未提交依赖补丁的本地 stash 以便审计。

六个测试各使用独占子进程、10 秒 OS 超时 / SIGKILL、128 MiB JS heap 和极小合成输入。
验证进程实际加载 `@img` sharp binding 与 bundled libvips（Node diagnostic sharedObjects 仅在内存中筛选，
不输出完整 report），并检查 sharp 的预编译库版本清单 rsvg >=2.63.2；它不是任意全局 librsvg 的动态版本证明。
真实解码验证 2×2 红色 RGBA 全部像素、PNG 编码/解码往返、损坏 XML 拒绝、超出 4 像素预算的 SVG 拒绝。
基线 0.35.4 的版本保护失败（rsvg 2.62.91），另外三项兼容性边界通过；原四项在补丁后全部通过。
另两项对 2×2 RGBA 灰阶做实际 lossless WebP / AVIF 编解码：尺寸、alpha、全部像素；WebP 完全一致，
AVIF 的 RGB/YUV 允许最多一个灰度级舍入，并检查官方 HEIF input 后缀 / output alias 仅为 AVIF。
没有获取到上游 CVE 触发样本（GNOME work item 访问受限），不声称复现、检测或全面排除该 UAF。

Docker CI 以只读挂载复用同一测试，在本次构建的真实 standalone 镜像中执行，禁网且整个 Docker 命令
60 秒超时；测试脚本不新增到生产镜像。任何 native 库缺失、全局库无法证明、版本保护或解码失败均阻断
完整 Docker 证明。既有安全门、Docker 检查和发布准入没有删改。

## 启动基线候选的本地验证

环境：macOS arm64，Node 24.19.0 / npm 11.17.0；合成数据与 worktree 隔离。

| 验证 | 实际结果 |
| --- | --- |
| 基线 `npm ci` / audit | 可安装；audit 2 high（sharp 公告及 Next 传递影响），rsvg 2.62.91 |
| 补丁 `npm ci` | 干净重装成功；502 packages，audit 0 |
| `npm ls sharp source-map-js --all` | sharp 0.35.5，source-map-js 1.2.2，没有旧副本 |
| `npm audit --audit-level=high`（全部依赖，JSON） | 退出 0，所有严重度均 0 |
| registry / lock 结构核验 | 27 条目 tarball/integrity 一致；其他锁条目字节对应内容不变 |
| `node --test ops/sharp-security.node-test.mjs` | 4/4；绑定与库确实加载；rsvg 2.63.2 / vips 8.18.7 |
| `npm run typecheck` | TS7、TS6 的 app / tools 全部通过 |
| `npm run lint` | 通过，零 warning |
| `npm run test:coverage` | 262 Vitest 文件 / 2759 测试；162 ops Node 测试通过；覆盖率门通过 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 生产 webpack 构建通过，C5 receipt：23040 ms，builds=1 |
| 同环境 `npm run test:e2e:built` | 7 文件 / 8 HTTP 测试；receipt 复用，additional_builds=0 |
| 同环境 `npm run test:browser:built` | D4 与 D3 共 7/7；receipt 复用，additional_builds=0 |
| 更新版本保护的加载路径核验后 | 定向重新运行 4/4 原生测试与 lint 均通过 |
| 本地 Docker | daemon 未运行，buildx 也不可用（context 检查退出 125）；未擅自修改环境；完整 Linux Docker 由候选 CI 验证，当前尚待运行 |

C5 构建输入 SHA256 `a71191c55556ee20731fb39db2c475a10001c9d2f7022a179d7275e8e48bb42c`；
构建产物 SHA256 `092f05c4cefd8043ae9da90db8c26ef86c3d27a31b1169a21e8f129ae7f6c4c7`。
本地构建 receipt 的 git head 是未提交候选基线，输入 hash 绑定候选构建输入；它不冒充已提交精确 head 的 CI。

## 5539 基线首轮候选验证（历史）

由于基线前移及版本保护测试的加载路径核验改变了 C5 输入，先前构建 receipt 正确拒绝复用。
当时的四文件候选在 5539 基线重新干净安装，以下全部通过；不把这份历史结果冒充最新候选。

| 当时的候选命令 | 实际结果 |
| --- | --- |
| `npm ci` / `npm ls sharp source-map-js --all` | 干净安装；sharp 0.35.5 / source-map-js 1.2.2 |
| `npm audit --audit-level=high --json` | 退出 0，全依赖各严重度均 0 |
| `node --test ops/sharp-security.node-test.mjs` | 4/4，预编译库路径保护与实际 SVG 边界通过 |
| `npm run typecheck` / `npm run lint` | TS7/TS6 app/tools 通过；lint 零 warning |
| `npm run test:coverage` | 262 Vitest 文件 / 2759 测试 + 162 ops 测试，覆盖率门通过 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 生产构建通过；15226 ms，builds=1 |
| 同环境 `npm run test:e2e:built` | 7 文件 / 8 HTTP 测试，additional_builds=0 |
| 同环境 `npm run test:browser:built` | D3/D4 共 7/7，additional_builds=0 |

当时的 C5 输入 SHA256 `03387eaae225cbc4ee00f8c483c1114ef49a566faf61070cc279023131360f30`，
产物 SHA256 `6db5abc80c41d9992ecafd83be72d69304d3a6165eb343e56c798f62387ff322`。
新基线精确主干 [CI 37503548677](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37503548677)
attempt 1 已成功（push / head=tested=`5539ec136ca8a087f190670332bae87db5bfdbbe`，
应用、全依赖 audit、HTTP、browser、Docker 与必需入口通过）；它不替代本 PR 最终候选的 CI。

## 首轮 CI 失败与跨平台修正

[PR #427](https://github.com/dong-qiu/deep-insight-agent/pull/427) 首轮 head
`5c506a79cc892a9600bf09dc125eb279c6c382dd`，
[CI 37504892238](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37504892238) attempt 1，
tested `ce1ae08164b5414dc96016592d564398ef8cdc42`，scope full，实际结果 failure。
Linux 应用 coverage 与 standalone Docker 的 bundled libvips 原始字符串路径断言失败；sharp binding
检查及三个真实 SVG 解码边界通过。后续 audit 未执行，没有完整 prototype CI / Docker 成功证明。

[官方 binding.gyp](https://github.com/lovell/sharp/blob/v0.35.5/src/binding.gyp) 显示 Linux RPATH
采用 `$ORIGIN/../../sharp-libvips-…/lib`，据此推断未规范化路径导致原匹配失败；日志没有直接输出原始库路径，
不冒充直接观测。修正仅对 diagnostic report 中候选 `@img/sharp-` 路径执行 `realpathSync` 后继续
原有 binding / bundled libvips / librsvg 条件，解析失败仍 fail closed，不跳过或放宽安全条件。
不输出完整 report、环境或私有路径。新候选完整 Linux CI 必须再次通过应用与 Docker 两处检查。

修正后独立 reviewer 再次通过定向代码审查，Blocking 0 / Warning 0，并独立复现 4/4。
本地再次运行：4/4 原生测试、lint、coverage（2759 Vitest + 162 ops）、C5 生产构建、HTTP 8/8、browser 7/7
全部通过。构建 13067 ms / builds=1，HTTP/browser 同构建复用 / additional_builds=0。
C5 输入 SHA256 `e0ba31946921a8f7730631f113738a7680bb4dade21c7d5554510e7e50194213`，
产物 SHA256 `c0bace45b53e38a4de8e670b77e42f9ebc73f7fe81deef05e8b882559b824190`。
当时 package、应用和类型输入未变；后续主干 #360 推进后，最终基线验证另行完整执行，不将此结果替代最终 CI。

## 1bf 主干候选验证（历史）

为满足 strict up-to-date，使用正常 feature branch merge 接纳 #360 的已提交主干变化，保留该 PR 的
文件原样，不主动修改共享 roadmap / ADR；相对最新主干仍只有本任务四文件。没有 force push 或清理 stash。
最新基线的最终本地完整验证全部通过：

| 命令 | 实际结果 |
| --- | --- |
| `npm ci` / 全依赖 `npm audit --audit-level=high --json` | 干净安装，全部严重度 0 |
| `npm run typecheck` / `npm run lint` | TS7/TS6 app/tools 通过；零 warning |
| `npm run test:coverage` | 263 Vitest 文件 / 2774 测试，ops 162/162（含四项原生保护），覆盖率门通过 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 14619 ms，builds=1，生产 webpack 构建通过 |
| 同环境 `npm run test:e2e:built` / `npm run test:browser:built` | HTTP 8/8、D3/D4 browser 7/7，同构建复用 / additional_builds=0 |

最新 C5 输入 SHA256 `5c39fcb58d80946685373705a7159489a4009a13b586345b0fd80374363c09c3`，
产物 SHA256 `9abd5a4032a201270e5450207f08d7dfd4aa57dbe1beb27f3a883085cf644b6c`。
继承 #360 的离线 export 测试使 Vitest 计数增加，不属于本 PR 自身变化。
最新基线主干 [CI 37505217117](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37505217117)
full success；最终候选与 Linux CI 仍待绑定，不用主干成功替代 PR CI。

## 第二轮 Docker 失败与平台清单包装

第二轮 head `edfc059cc32530df8aa6ed8cae0a351131bc8bfa`，
[CI 37506441067](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506441067) attempt 1，
tested `4acfda57fc3b9f3687130a791cce193029fb18af`，full，整体 failure。
应用完整成功（Linux 原生路径保护和 rsvg 2.63.2、coverage、build、HTTP、browser、audit 0 均通过）；
Docker 真实 binding / bundled libvips 断言通过，但 `sharp.versions.rsvg` 为空，不能生成成功 Docker 证明。

本地直接 createRequire 载入 `.next/standalone` 的真实 sharp，版本仅 `{vips:8.18.7, sharp:0.35.5}`，
确认平台 `versions.json` 被动态 trace 漏带。[官方版本 API](https://sharp.pixelplumbing.com/api-utility/#versions)
及 [utility.mjs](https://github.com/lovell/sharp/blob/v0.35.5/lib/utility.mjs) 表明：缺清单时静默 fallback，
恢复清单也恢复 HEIF 的 AVIF input suffix / output alias。这是实际格式声明恢复，不宣称没有运行行为影响。

Dockerfile 仅新增同一次 builder `npm ci` 已安装的 `@img` scope COPY，保留平台 binding、库、清单与
既有 colour 依赖；无额外下载、版本漂移或私有文件，架构无关，不复制全 node_modules。
在隔离临时目录复制 standalone 的原生依赖闭包模拟该行 COPY：补齐前缺清单、版本检查失败；
补齐后 rsvg 2.63.2，原四项原生检查通过。原 worktree node_modules 未改写源码。
独立 reviewer 同意包装修正，提出补 WebP/AVIF 回归以覆盖格式声明恢复；已加入同一脚本并独立复现 6/6。
该 Warning 已处理，代码定向审查 Blocking 0 / Warning 0；最终五文件收据与冻结差异另行复核，
Linux 必须新 head 完整 CI，不把模拟复制或前轮应用成功当作最终 Docker 通过。

## 最终 cc837 基线 / 五文件候选本地结果

本地一次 `npm run test:coverage` 出现两项既有测试的 5000 ms 超时：`tests/next-root-glob.test.ts`
与 `evals/export-qualified-tech-leads-v2.test.ts`，263 文件中 261 通过、2774 测试中 2772 通过。
未将其归因于 sharp，也未修改超时、worker 配置或覆盖率门；原命令重试后全部通过。

| 验证 | 最终结果 |
| --- | --- |
| 六项原生 / codec probe | 正常安装 6/6；隔离 traced 闭包精确模拟 COPY 后也 6/6 |
| lint | 零 warning；typecheck 的 TS7/TS6 输入与此前通过版相同（仅新增原生 JS 测试和 Docker 包装），CI 仍重跑 |
| `npm run test:coverage` 原命令重试 | 263 Vitest 文件 / 2774 测试 + 164 ops 全部通过，覆盖率门通过 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 22334 ms，builds=1，生产 webpack 构建通过 |
| 同环境 `npm run test:e2e:built` / `npm run test:browser:built` | HTTP 8/8、D3/D4 browser 7/7，共用该构建 / additional_builds=0 |
| 干净安装 / audit | 依赖文件不变，先前干净安装及全 audit 0 仍适用；第二轮 Linux 应用也确认 0；最终 CI 仍独立干净重装和全审计 |

最终 C5 输入 SHA256 `1c81a250d7a4b496a038526d4c68ec97edf6a47422822da3f9d6f1824175a0ee`，
产物 SHA256 `55463c68130723cbe73bc2b63c805c2c2be86a36898194df89ba9edcfd162c5d`。
主干 #428 仅两份文档，均原样继承；相对 `cc837b1` 的最终完整范围严格为五个本任务文件。
最后完整审查、候选精确 SHA、可信 CI run / tested SHA / 三份证明身份在 PR 摘要补齐，保持最终 head。

## 评测、独立评审与最终 CI

eval-gate：此次实际变更涉及原生图像依赖调查、保护测试、CI 与镜像原生闭包包装，不改 AI 语义或数据源。
src 没有 sharp / next/image 直接调用；Next 内置图像优化调用 sharp，A1 不执行这条图像解码路径。
因此不适用真实模型 A1，以完整功能、构建与解码回归证明本次路径兼容；不预签“依赖永不影响输出”，
未调用付费模型。

pre-pr-ai-review：新上下文独立 reviewer 已审查前两轮完整四文件 diff，Blocking 0；指出一处旧 override
表述与新基线矛盾，已改为明确区分启动基线 0.35.4 / 最终基线 0.35.5。独立复现原生测试 4/4、
依赖树与全 audit 0，逐项核对官方公告、发布时间、全部 27 包 registry 元数据、没有无关依赖漂移，
确认保留既有安全/发布门，测试不冒充 CVE 复现。最终收据已完成独立定向复核，前置审查通过：
Blocking 0 / Warning 0（原文档 Warning 已处理）；候选 PR 的完整 CI / Docker 仍待执行。
首次提交后在同一 Draft PR 摘要补充精确候选 / tested SHA、独立远端 diff 复核、完整 CI run / attempt / jobs、
scope 与 prototype CI / Docker JSON 的身份、SHA256、artifact ID 和实际过期时间；不为追加 CI 链接制造新提交。

## 未核验与回退限制

项目没有直接 sharp 或 next/image 调用。`next.config.mjs` 未覆盖 images 配置；当前安装的 Next 默认
`dangerouslyAllowSVG=false`、remotePatterns 为空，imageOptimizer 对 SVG 返回 400。
`src/middleware.ts` 排除了 `/_next/image`，所以不能将普通认证门当成图像入口的安全证明。
默认拒绝策略和调用调查不证明所有生产攻击路径不可利用：真实运行 SHA、环境、PIE、已加载 librsvg、
不可信 SVG 进入其他解码入口的路径均未核验。CSP、source-map 配置与应用业务源码未变；
镜像恢复 sharp 的官方格式声明，影响及验证见包装章节。

依赖补丁已由另一会话的 #426 合入主干；本次独立保护/证据 PR 尚未合并。本会话未部署，
实际生产上线状态未核验。
不触碰生产数据，不清理。回退 override / 锁文件至 0.35.4
会重新引入已知漏洞，不能作为安全完成方案；若出现兼容问题，须保留安全版本调查或制定另一项已验证修复。
