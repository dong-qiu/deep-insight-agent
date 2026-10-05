# D5 / TD-18：构建依赖收敛

日期：2026-10-03。承接 [技术债验收清单](technical-debt-remediation.md) 的 TD-18；现场基线为 `origin/main` @ `1c40eac4ebd018cce4874d75332ed3f8dc97cabf`。C5 已由 PR #396 / #397 完成，继续保留 [C5 构建复用及身份校验](../../verify/c5-ci-build-reuse-2026-10-03.md)。本 spec 先于依赖实施创建。

## 范围与处理顺序

只审计并收敛直接使用的构建工具及 Node 类型版本，登记临时编译器/vendor 补丁的退出条件。没有应用、模型、prompt、引用校验、来源、评测口径、数据迁移或生产部署变化；不实施 C4a，不修改共享 roadmap/ADR。

2026-10-03 现场查询：Dependabot #373（AWS SDK 四包）、#375（Vitest/coverage/Vite）、#382（Anthropic SDK、Node/nodemailer types）均 OPEN，三者均修改 `package.json` 和 `package-lock.json`。#382 还将 `@types/node` 从 26.6.2 更新到 26.6.3，与本切片的运行时对齐直接冲突。

后续集成队列为 **D5 → #375 → #373 → #382**：先固定构建契约，再复核测试工具链，再处理 AWS 运行依赖，最后单独重算混合 SDK/types PR。每一步只能在前一步完成评审并合入后的最新 main 重算 lockfile、审查和验证；此队列不授权本会话合并、更新或自动重建这些 PR。#382 必须保留 Node 24 类型约束，不能原样带回 Node 26。所有后续 PR 保留 vendor overrides 和 C5 入口。

## 验收标准与反例

| AC | 验收要求 | 失败边界 / 证据 |
| --- | --- | --- |
| D5-1 | npm scripts、配置、CI 与 Docker 直接调用的工具都能映射到显式依赖或系统运行时 | Docker 三个 runner 直接调用 esbuild，不得依赖 tsx 的传递 hoist；声明当前 lockfile 的 0.28.1，不顺带更新工具链 |
| D5-2 | Node runtime、CI、Docker 与应用 Node types 主版本一致 | Node 24.19.0 / engines `>=24.19 <25` 保留；在 Node 24 下验证 24 系 types，若出现真正缺失的运行时 API 须先诊断，不能用 Node 26 types 掩盖 |
| D5-3 | 安装可重复，lockfile 只包含所需变化 | 独立 worktree 干净 `npm ci`；对比全部 lock entries，运行 audit；禁止批量 update 或更换原生 SQLite 版本 |
| D5-4 | 双编译器与安全补丁都有保留理由、责任窗口、复查时间、退出条件 | 专属收据登记 TS6/TS7、image-size、Next root glob；退出须以实际调用兼容性、安全回归和 audit 证明，不能仅因上游发布新版本就删除 |
| D5-5 | C5 的构建身份与拒绝边界保持有效 | 原 C5 Node 32 用例及递归运维套件通过；`build:e2e → test:e2e:built` 复用一次构建，lockfile/source/运行身份变化仍拒绝 |
| D5-6 | 两个 TS 版本均检查 app 与 tools；受影响测试、lint、应用/E2E、Docker 全通过 | Node 24 下实际测试 vendor 安全回归和 esbuild runner；CI 保留 coverage、供应链、P1 共用边界及独立 Docker gates；不能用本地 bundle 代替真实容器运行 |
| D5-7 | 最终 diff 独立审查，Draft PR CI 绑定最终候选 | 仓库 pre-pr-ai-review 使用独立上下文；D5 收据记录本地与 CI 证据、风险、PR 链接；未合入不称 TD-18 主干关闭 |

## 验证与回退

实现前先记录直接工具/版本审计；实现后在独立安装的 Node 24.19.0 / npm 11.17.0 环境运行干净 `npm ci`、受影响测试与运维测试、`npm run typecheck`（TS7/TS6 app/tools）、lint、audit、`npm run build:e2e` 与 `npm run test:e2e:built`。Docker 使用现有 CI 的 Linux amd64 独立构建、镜像 assets 与 HTTP/auth/dispatch smoke；本地没有 Docker daemon 时如实记录，由最终候选 CI 提供容器证据。

Eval-Gate：依赖声明与类型约束不改变合法输入的 AI 输出及评测口径，不调用模型；A1 不执行本次构建收敛路径，使用确定性回归、类型检查、应用和容器证据。

回退为成对还原 package/lockfile 与本切片 Dependabot 约束，无 schema 或生产数据操作；仍保留 C5 和必要 vendor 补丁。初始实施阶段只创建 Draft PR 和验证；后续仅在用户授权下完成 D5 合并与主干收据归档，见 [完成收据](../../verify/d5-build-dependency-convergence-2026-10-03.md)。不部署、不清理分支/worktree，不实施其他切片。

## 保留项与退出登记

维护责任为构建依赖集成窗口；每次工具链/相关上游更新 PR 复查，最迟下一次复查日期为 **2026-11-02**（30 天）。这不是指派其他会话立即实施。

| 保留项 | 当前保留依据 | 退出条件 |
| --- | --- | --- |
| TS6 `typescript@6.0.3` + TS7 alias `@typescript/native` → `typescript@7.0.2` | TS7 通过显式路径运行 native CLI，TS6 提供 Next 的 `typescript/lib/typescript.js` 和运维测试使用的 compiler API；已安装 typescript-eslint 8.66.0 的 peer 要求 `>=4.8.4 <6.1.0`，不能只删除 TS6 或把普通 `typescript` 换成 TS7 | Next/compiler API 调用方支持目标单编译器，ESLint peer 范围匹配；app/tools 两种检查结果无回归、运维 compiler API 测试、lint、build/E2E/Docker 通过后，独立 PR 收敛到一个版本并更新测试契约 |
| `vendor/image-size` 与全图 override | 维护镜像 v2.0.3 基于上游 v2.0.2，包含零长度 ISO box 和镜像补充的零长度 ICNS entry 拒绝；现有安全用例分别执行真实 `findBox` / `imageSize` | 官方发布确认包含完整 ISO/ICNS 修复；同一真实解析器安全回归、安装、全图 audit、应用/容器构建通过；在独立 PR 同时替换直接依赖、override 和 vendor，不能只撤 override |
| `vendor/next-root-glob` 与 scoped override | 已安装 Next ESLint 16.3.8 的实际 caller 仅需 directory `globSync`；原 fast-glob → micromatch → braces 链因 GHSA-vfj7-8cjw-p6xm 被替换为固定 tinyglobby/picomatch；不是完整 fast-glob 替代 | 官方 Next plugin 去掉漏洞链或上游正式修复且保持 root/lint 行为；复跑真实 plugin/root discovery、安全边界、lint、clean install、audit、build/Docker，再在独立 PR 同时移除 scoped override/vendor；任何 plugin/caller 更新先重审适配兼容性 |
| `@types/node` major ignore | engines、CI、Docker 都固定 Node 24 系；24.x types 仍可以由 Dependabot 提议更新 | 运行时 Node major 迁移先同步 engines、CI、Docker 与真实运行验证，再同步 types 主版本并复核 ignore；不以类型包发布替代 runtime 迁移 |

当前两个 vendor 的实现、包版本与 override 均保留；本切片 audit 0 仅证明当前安装图，不证明上游补丁已可替代。补丁细节继续以 [image-size provenance](../../../vendor/image-size/SECURITY_PATCH.md) 和 [Next adapter contract](../../../vendor/next-root-glob/SECURITY_PATCH.md) 为准。
