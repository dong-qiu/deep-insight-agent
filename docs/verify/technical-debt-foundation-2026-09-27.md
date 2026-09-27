# 技术债治理第一批：测试入口、数据库初始化与数值配置

日期：2026-09-27。基线：`origin/main` @ `21414ab702282a5fc3645cea15afe26f1e042c07`。
分支：`fix/tech-debt-foundation`。

## 变更摘要

- 落地 [20 项分批实施计划](../plan/specs/technical-debt-remediation.md)，本批仅实施 A1/A2/A3。
- `test` / `test:coverage` 共用 Node 运维测试自动发现入口，补上 gen-env、forward observation、branch cleanup 等测试。
- 双 TypeScript 检查通过独立 `tsconfig.tools.json` 纳入 ops/tests，Next 应用构建范围不扩展。由此发现的 S3 重载返回类型误用改为 `GetObjectCommandOutput`，前后转译 JavaScript 完全相同。
- `getDb` 完成全部初始化后才发布单例，失败关闭临时连接；`openDb` 的自身初始化失败也释放连接。
- 6 项危险数值配置拒绝非法值；`chunkWindows` 保护显式 size 参数，合法输入算法保持不变。

## 验证

本地验证环境：隔离 worktree；Node `24.19.0`。该阶段未复制 `.data` 或 live SQLite，未调用付费模型或生产服务；后续生产核验另见末节。

| 命令 / 实验 | 结果 |
|---|---|
| 新增 DB 反例在修复前运行 | 5/5 失败：连续 guard 拒绝被绕过、失败连接未关闭、修正配置后仍返回旧连接 |
| 修复后的 10 文件定向回归 | 329 tests 通过，涵盖初始化、迁移、部署、env、Analyzer、Validator、LLM |
| `npm run test:coverage` | Docker 边界修正后重跑：212 个 Vitest 文件，2,142 tests 通过；随后实际运行 Node 运维测试 24/24 通过 |
| 覆盖率 | statements 76.48%、branches 69.03%、functions 76.75%、lines 80.38%，现有阈值未调整 |
| `npm run typecheck` | TS7、TS6 的应用/工具共 4 项检查均通过，包含新纳入的 ops/tests |
| `npm run lint` | 通过 |
| `npm run build` | 通过；存在仓库已有 middleware → proxy 弃用提示，本批未迁移 |
| `npx vitest run --config vitest.e2e.config.ts` | 复用刚构建的应用，3 文件 / 3 tests 通过；分别使用测试数据库 |
| `git diff --check` | 通过 |
| 运维脚本前后 TS 转译结果对照 | `ops/replay-redaction-registry.ts` 输出 JavaScript 相同，纯类型修正 |
| 本 worktree `.env.local` 六项数值合法性检查 | 通过；不打印值。不是生产配置核验 |

### 确定性行为边界

- DB 测试使用真实内存 SQLite 和真实 migration/deployment guard，连续调用两次；其余注入覆盖 schema、报告协调、raw 协调、方向播种及关闭失败。
- 正常初始化完成后复用同一连接；失败后重试；清理抛错不覆盖原始错误；`closeDb` 可重复调用。
- 窗口测试调用真实 `chunkWindows`，对照修复前算法的 42 组固定输入组合，包含中英文、空白、短文、长文与多种窗口长度；保留逐字连续切片。
- 非法窗口尺寸在实际调用处拒绝；非法长度环境变量在实际 Analyzer 模块加载时拒绝。
- 运维测试发现覆盖嵌套目录、稳定排序、符号链接排除、空集拒绝、子进程非零/信号/启动错误；两个 npm 入口共享该实现。

## Pre-PR AI Review

- 基线：`origin/main` @ `21414ab702282a5fc3645cea15afe26f1e042c07`
- 范围：测试入口/TS 范围、DB 初始化、数值配置与 Analyzer 窗口保护、实施计划与测试
- 风险级别：中
- 结论：通过

独立 reviewer：`tech_debt_foundation_review`，使用全新上下文，只读审查最终代码 diff 与全部新增实现/测试。

### Blocking

- 无。

### Warning

- 无。

### 独立验证

- 6 个 Vitest 文件共 280 tests 通过：initialization、numeric-env、env、analyzer-window、analyzer、validator。
- `npm run test:ops`：23 tests 通过。
- `git diff --check`：通过。
- 审查确认调用链没有初始化期间重新进入 `getDb`；成功路径顺序未变；6 项合法配置解析、读取时机及窗口算法未变。

Blocking: 0; Warning: 0

## Docker CI 首轮发现与修正

[首轮 CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36326511865) 的主验证作业全部通过，
包括完整性、容量、读取性能、E2E 和依赖审计；Docker build 失败，不能称为 CI 全绿。

原因：直接扩展应用 `tsconfig.json` 的根文件让 Next 检查 `ops/prototype-release.ts`，但 Docker
按既有约定排除了该脚本所依赖的 `evals/prototype-safety.ts`。完整 checkout 的本地构建不能复现这个裁剪边界。

修正：恢复应用 tsconfig 的原始范围，新增 `tsconfig.tools.json`，让 TS6/TS7 在普通 CI 中分别检查
应用与工具。新增测试通过 TypeScript 配置解析 API 确认两者根文件边界，未放宽 `.dockerignore` 或关闭类型检查。
修正后重新运行全量覆盖率（2,142 + 24 tests）、双版本应用/工具类型检查、lint、production build
及 3 个 E2E，全部通过；覆盖率数值不变。远程 Docker 以新提交 CI 为准。

独立 reviewer 针对该 delta 再次审查通过，Blocking / Warning 均为 0；独立运行 TS6/TS7 的
应用/工具 4 项检查（关闭增量缓存）、配置边界测试 4/4、运维测试 24/24 及 diff check，均通过。

## AI 输出质量

评测例外：已按 eval-gate 核对，属于确定性失败边界与配置保护；缺失默认值、合法配置的模型输入与重试次数、模型、provider、thinking、prompt、引用/一致性/展示语义均未改变。Analyzer 改动只增加非法尺寸保护并收敛长度配置读取。使用上述对照和真实函数离线回归，不运行无新增覆盖价值的真模型 A1；不声称获得新 baseline、DCP 或模型质量提升。

提交使用 `Eval-Gate: skip (deterministic initialization/config guards; valid-input behavior unchanged; offline regressions passed)`。

## 风险、发布和回退

- **兼容性边界**：6 项环境变量的显式空值/空白、非数值、无穷值、越界或不允许的小数现在报配置错误。未设置仍使用原默认值；合法 `0` 重试 / `0` 退避继续支持。
- 发布前只核验上述配置是否合法，不输出值。旧空值应删除以使用默认值，或填写合法值；最初的本地检查已由下方生产预检补齐。
- 不更改 schema、迁移历史、报告文件和存量记录。可回退代码；不要靠回退恢复非法窗口循环。
- A 批已合入并部署，证据见下节；B1a 在后续独立分支启动。全局配置注册、旧会话撤销、读者可见性规则、备份和任务取消等不能据此记为完成。

## 合入、生产核验与清理（2026-09-27）

- [PR #359](https://github.com/dong-qiu/deep-insight-agent/pull/359) 于 15:14 UTC 合入，
  merge SHA `5f8efa0da00e5658182c659dbfdc728c7f7f832c`；原分支 head 为 `c10dbcfd8bd84e05fe435c26de4acabced3f2c23`。
- [主干 CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36328803794)、
  [不可变镜像构建](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36329266918)、
  [生产部署](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36329479595) 均成功。
- 生产预检执行本次 `env.ts` 的同一解析函数：六项变量均未显式设置、原默认值合法；不输出值，不改生产配置。
- 15:24 UTC 切换前检查：运行 Run = 0，queued/claimed dispatch = 0；没有并行发布，避开 16:50–17:30 UTC 管线窗口。
- 按指定 SHA 镜像 code-only 切换，未覆盖 `.env.local`。实际运行 SHA 与 merge 一致，digest 为
  `sha256:affc0449caf326780457a1f05374fce7a561b088ccafb7268dccf00c0254758a`。
- `/api/health` 200 / DB `ok`；worker 专用健康检查 200 / `ready`；app、worker 健康，cron 运行；
  两次相隔超过 30 秒的检查均为零重启。
- 只读 DB 查询报告数为 286，与发布前一致；最新完成报告的 md/html 文件可读且非空；
  使用现有管理员凭据在内存中登录，真实报告页面返回 200、正文非空。未打印凭据、cookie 或正文；未生成新报告。
- 清理前 dry-run 与 PR 元数据确认分支没有在合并后推进、worktree 干净且未锁定。
  仅移除本批 `insight-agent-tech-debt-foundation` worktree 和 `fix/tech-debt-foundation` 本地分支；
  远程 head 已自动删除。其他清理候选及并行日报信息密度工作均保留。
