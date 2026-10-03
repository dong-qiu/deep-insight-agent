# D5 / TD-18：构建依赖收敛收据

验收见 [D5 spec](../plan/specs/build-dependency-convergence.md)。本收据区分本地结果、候选 PR CI 和主干/生产状态；本会话仅 D5，不合并、不部署、不清理分支。

## 现场基线与隔离

- 启动已读取仓库 AGENTS.md、独立计划工作区的 `technical-debt-parallel-execution.md` 和 `technical-debt-preflight-2026-10-03.md`；历史快照的 C5 待实施状态不再适用。
- fetch 后 `origin/main` 为 `1c40eac4ebd018cce4874d75332ed3f8dc97cabf`（PR #397）。主干 [CI 37131477845](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37131477845) 与 [镜像发布 37131800615](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37131800615) 均 success；未因此推断实际生产版本，本次没有生产查询或部署。
- 从上述 SHA 新建 `chore/d5-build-dependency-convergence` / `/Users/dongqiu/Dev/code/insight-agent-d5-build-deps`。从主 worktree 仅复制 gitignored `.env.local`，权限 0600，DATA_DIR/DB_PATH 显式指向新 worktree；未复制 `.data/`、SQLite/WAL/报告或 `.env.development.local`。
- 原有 8 个 worktree 均保留；主 worktree 的 roadmap/ADR 两项修改与四份未跟踪文档未碰。日报 worktree HEAD 已推进到 `9b84e12`，计划工作区 HEAD 为 `7342576`，不把它们当作无人使用。现场没有 C5 分支/worktree，C5 已完成，不重做。
- 已在新 worktree 读取 [C5 收据](c5-ci-build-reuse-2026-10-03.md)，CI、Dockerfile、构建脚本和身份校验实现保持不变。先写 D5 专属 spec，再修改依赖；共享 roadmap/ADR 未修改。

## Dependabot 队列与重叠

以下为本次查询快照；只读查询，没有合并、关闭、重建或推送这些分支。

| PR | 状态 / head | 内容 | 重叠与后续要求 |
| --- | --- | --- | --- |
| [#375](https://github.com/dong-qiu/deep-insight-agent/pull/375) | OPEN / `8417608821d7b5f9a38f13e16655d62dedb77ffa` | coverage/Vitest 5.0.3、Vite 8.3.1；Vitest 的更新包含 lockfile | package/lockfile；先在 D5 合入后重算，确认 esbuild pin 与测试工具 peer 兼容 |
| [#373](https://github.com/dong-qiu/deep-insight-agent/pull/373) | OPEN / `8173dd26a4aaa3e7e5d657eabf5818420598b4b4` | 四个 AWS client 3.1136.0 → 3.1143.0 | package/lockfile；接前一项后串行验证 AWS recovery bundle 与运行时路径 |
| [#382](https://github.com/dong-qiu/deep-insight-agent/pull/382) | OPEN / `aff6f4559929cc9ea283ff455a90a272b3246d37` | Anthropic SDK 0.127.0 → 0.129.0、Node types 26.6.2 → 26.6.3、nodemailer types 8.0.1 → 8.0.2 | package/lockfile，且 Node types 与 D5 直接冲突；最后重算，必须保持 24 系 types，不原样应用该 hunk；SDK 行为另按 AI 质量范围判断 |

建议集成顺序 **D5 → #375 → #373 → #382**，每一步以最新 main 为基线重新审查与验证，不平行合并 lockfile。此顺序是后续交接安排，本会话不执行这些 PR。

## 直接工具与最小变更

| 真实调用点 | 显式依赖 / 结论 |
| --- | --- |
| npm build/dev/start；Next config | `next@16.3.8` 已直接声明；webpack 由 Next 自带，配置仅修改其 resolver，不直接调用独立 webpack 包 |
| scripts 与 CI 的 tsx；Vitest/config/coverage | `tsx`、`vitest`、`vite`、`@vitest/coverage-v8` 已声明，不更新版本 |
| ESLint config 与 CLI | `eslint`、`eslint-config-next` 已声明；scoped root adapter 也是显式 file dependency |
| typecheck 的两个 CLI、运维 compiler API | `typescript@6.0.3` 与 alias `@typescript/native` → 7.0.2 已声明，显式 CLI 路径和 app/tools 检查保留 |
| Docker 三个 TS runner bundle；两组 replay Node 测试的 esbuild API | 新增精确 `devDependency esbuild@0.28.1`，与既有传递安装版本一致；Docker deps 阶段安装 devDependencies，runner 镜像不需要 esbuild |
| Node/npm、Docker/Buildx、supercronic | 前者为 engines/CI/镜像运行时或 CI action 提供的系统工具；supercronic 使用现有固定版本及校验，不作为 npm 依赖 |

只新增 esbuild 直接声明、将根 `@types/node` 改为 `^24.19.1`，以及 Dependabot 将 esbuild 归入工具组、Node types major ignore。npm 重新生成 lockfile 后，逐 entry 对比仅根声明、`@types/node` 26.6.2 → 24.19.1、其 `undici-types` 8.9.0 → 7.24.6 变化；所有运行依赖、esbuild、两个编译器及 vendor/overrides 版本不变。

## Node/runtime/types 验证

本机默认 Node 25 不符合项目 engines，所有安装、编译器、测试、lint、构建/E2E 均显式使用 `/Users/dongqiu/.nvm/versions/node/v24.19.0/bin`：Node 24.19.0、npm 11.17.0，与 CI/Docker 的 Node patch 一致。

不能仅看声明的 `@since` 推断 API 不存在：首个 `net.BoundSocket` probe 在 Node 24.19.0 已是 function，属于回移 API，未作为类型错配证据。最终反例从 npm 原始 26.6.2 types 在临时目录提取，以 TS6/TS7 编译 `import { text } from "node:stream/iter"; void text([new Uint8Array([65])]);`：两者均通过；同一 Node 24.19.0 的实际 import 抛 `ERR_UNKNOWN_BUILTIN_MODULE`。切换为本项目安装的 24.19.1 types 后，两个编译器均以 TS2307 拒绝该 probe。临时 probe 与 types 包不入仓，没有改变应用代码。

应用与 ops/tests 的四项真实类型检查在 24 系 types 下全部通过，因此无需为对齐类型修改运行逻辑。`npm ls` 证明 Vite/Vitest 等使用根 24.19.1，pptxgenjs 自身的嵌套 22.20.1 types 保留，不以全图 override 强制改写第三方契约。Node types major ignore 的退出条件随运行时 major 迁移登记在 spec，24.x 更新仍正常提出 PR。

## 双编译器和 vendor 保留登记

保留理由、退出条件、责任窗口与最迟 **2026-11-02** 的复查时间见 [spec 保留登记](../plan/specs/build-dependency-convergence.md#保留项与退出登记)。TS6 当前为 Next 默认 compiler API 及 ESLint peer 所需，TS7 保留显式 native CLI 回归；image-size 的 ISO/ICNS 补丁与 Next root glob 漏洞链替代仍必要。当前安装图 audit 0，不将其误写为上游修复已核实或 vendor 可以退出。本切片未更换补丁实现。

## 本地验证

| 验证 | 结果 |
| --- | --- |
| 基线和变更后干净 `npm ci` | 均成功；变更后安装 499 包 / audit 502 包，0 漏洞；lockfile 未漂移 |
| `npm run typecheck` | TS7 / TS6 的 app/tools 共四项全部通过 |
| `npm run lint`、`git diff --check` | 通过 |
| `npm run test:coverage` | 231 文件 / 2,345 用例通过，覆盖率门通过；递归 Node 运维测试 109/109（含 C5 32 用例及 replay esbuild 实际 bundle 反例） |
| vendor 定向测试 | `tests/next-root-glob.test.ts` 与 `src/lib/services/image-size-security.test.ts`，10/10 通过 |
| Docker 原参数本地 runner bundle + `node --check` | migration ESM、deployment ESM、replay CJS 三者均成功；仅为构建工具路径证据，不替代容器 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 应用 build 通过，`build_ms=19335, builds=1` |
| 同环境 `npm run test:e2e:built` | 验证收据后 E2E 6/6 通过，`additional_builds=0`；C5 身份复用保留 |
| `npm audit --audit-level=high` | 0 漏洞 |
| 本地 Docker/context | 未完成；daemon socket 不存在，Buildx 不可用（context checker 报 unknown flag），没有启动/更改其他会话 Docker 环境；由最终候选 Actions 独立 Docker job 补证据 |

构建时间只作单次功能收据，不宣称受控加速比例。npm 的现有 prebuild-install 弃用与 allow-scripts 提示仍在；没有新增安装脚本包，esbuild 早已运行其 postinstall，此次只把它提升为直接声明。

## Eval、独立审查与 PR

按仓库 eval-gate 核对：本切片仅构建依赖声明/types/依赖更新策略，合法输入的 AI 输出与评测口径不变，没有修改模型、prompt、来源、validator 或评测集。未运行 A1，它不验证本次依赖收敛路径；使用以上确定性测试与构建证据。提交使用 `Eval-Gate: skip (D5 build dependencies/types only; AI output and eval semantics unchanged)`。

独立 Pre-PR AI Review：新上下文按仓库 skill 审查完整五文件 diff，风险中，候选前置审查通过，Blocking 0 / Warning 0。reviewer 独立复跑四项 typecheck、vendor 10/10、ops 109/109、audit 0、diff/文档链接/Dependabot YAML 检查，并逐项比较 lockfile 628 entries，确认只有上述三项 entry 变化。审查没有修改文件。Draft PR 与候选 CI 尚待创建/执行，不能将本地结果记为 Docker 或主干验收。

## 风险与收口边界

后续 #382 的 Node 26 types hunk 需要重算，不能覆盖本次 24 系约束；后续工具升级须重验 esbuild 兼容性。双编译器和 vendor 是有退出条件的保留项，不是本次删除目标。回退仅依赖 manifest/lockfile 与 Dependabot 策略，无数据库迁移。

D5 本地实施、验证和独立前置审查已完成；仍需 Draft PR CI / Docker 证据及 PR 后独立复核。未合入，不把 TD-18 写成主干关闭；无生产部署、C4a 或其他切片实施，也没有修改/清理其他工作区、共享 roadmap/ADR。
