# C2b / TD-10 启动盘点收据

范围：启动时点的只读现场核对、工作区隔离、候选契约与独立方案评审。下文“尚未/待确认”均为当时状态。
契约见 [C2b 候选 spec](../plan/specs/c2b-task-budget.md)。不关闭 TD-10。

## 主干、前置和证据层级

`git fetch origin main` 后基线为 `c7648986d96e040dcad8c7e6dd01e75759c2bbee`。
已现场查询 PR mergedAt/mergeCommit，并核对 origin/main 历史：

| 切片 | 已合入 | 合并提交 |
| --- | --- | --- |
| C2a | [#406](https://github.com/dong-qiu/deep-insight-agent/pull/406) | 8a96b862894cbb65fdfd64f301469ad1ba37cdb4 |
| C3 | [#410](https://github.com/dong-qiu/deep-insight-agent/pull/410) | c7648986d96e040dcad8c7e6dd01e75759c2bbee |
| D4 | [#404](https://github.com/dong-qiu/deep-insight-agent/pull/404) | 142b1e38c0f07d0ff67d80611c2681a5ef11ffc8 |

精确基线的 [main CI 37213415190](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37213415190)
completed/success；同 SHA [镜像发布 37213621307](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37213621307)
completed/success。不据此写已部署，未访问或核验生产版本。
已有 C5/D5/C4a/C2a/C3/D4 不重复实施。

已读 AGENTS、L0/L2/L3、technical-debt-remediation、C2a/C3 spec 与专属收据、D4 收据，
架构的 Run/usage/成本控制段、ADR-0003 和 operations §14，以及 refactor-plan worktree
的 parallel-execution 参考；后者进度已过期，不整分支合入。
现行 ADR/运维规则优先于架构中未落地的 quota/cost_daily 草图。

## 隔离和文件归属

从最新 main 创建 branch `feat/c2b-task-budget`，linked worktree
`/Users/dongqiu/Dev/code/insight-agent-c2b`。
只复制主工作区 gitignored `.env.local`，权限 0600；DATA_DIR 与 DB_PATH 强制设为该 worktree
的 `.data` / `.data/insight.db`。未复制数据库/sidecar/原文/报告/.env.development.local，未输出密钥；
当前隔离 `.data` 尚不存在。本机默认 Node 25 不用于最终安装/验证，已定位 Node 24.19.0 的独立 bin。

主 worktree 分支 docs/brief-information-density-plan @ 21414ab 的 decisions/roadmap 未提交改动、
四份日报专属未跟踪文档保持原样。其他 Session 的 worktree 不更新、不清理、不运行其环境。

D1 只读 status 结果为：

- worktree `/Users/dongqiu/Dev/code/insight-agent-d1`，branch `refactor/d1-db-lifecycle` @ c764898。
- 未跟踪 `docs/plan/specs/d1-database-lifecycle.md`、`src/lib/db/d1-database-contract.test.ts`、
  `tests/fixtures/d1-main-v48-database-contract.json`；现场没有 tracked diff。
  收尾再读 status 时新增 D1 专属 `docs/verify/d1-database-lifecycle-preflight-2026-10-04.md`，
  已只读核对；其明确共享文件交接未确认、未实施 B/C 阶段，四项失败反例仍保留。
- D1 spec 状态为方案初审及边界反例阶段，连接/index、migration、startup/legacy 模块待交接。
  它声明不修改 runtime/预算、schema/repository 接口、共享 roadmap/ADR、package/CI/auth。
  干净 tracked diff 不意味着会话停止或文件已释放。
- C2b 不修改 D1 连接/迁移/启动和专属测试。候选 spec 申请 repos.ts 单个按 trace 查询 Run Cost
  的只读接口；共享文件未经确认不修改。当前仅写 C2b 专属 spec 和本收据。

## 调查结论和待确认策略

现有 budget 读 Run.cost；Job 中 onCost 金额尚未落盘，必须用作用域累计才可拦任务内后续 retry。
C3 attempt 不加入预算总和、P1 不加入；SDK 内部 retry 的真实 fetch 是必要检查点。
cron 已改为 durable 入队，所以旧“单 topic 过冲界”不涵盖 worker/多任务竞态。
unknown/partial/价格未知和 Coding Plan 不证明零费用，provider 不返回的消耗无法从本地推断。

推荐：无默认额度，可选任务 USD 上限；保持日/月粒度和手动提示策略；Run 兼容估价唯一消费；
未知继续并明确不确定，不预留、不宣称严格全局并发上限。完整候选 spec 包含任务身份/trace 恢复去重、
retry 接线、失败状态、fencing/C3 优先、残余风险与反例矩阵。用户确认前不实施。
如要求严格 reservation，需要新方案/共享 DB 文件交接，且仍缺可信单请求价格或套餐授权。

## 独立评审与下一步

已使用仓库 eval-gate 判断验证要求，并使用 pre-pr-ai-review 的新上下文 reviewer 审查方案。
本轮尚未盖 Eval-Gate 章：要以最终实现和正常路径回归证据决定是否 skip，不能预签。
新上下文方案 reviewer 只读核对 spec 与真实调用路径，Blocking=0、初轮 Warning=3：
并发 fail-fast 的费用收尾、同 trace 重启时 cap 未持久化、预算/C3/C2a 竞争原因。
均已在 spec 修订，并由 reviewer 复核：Blocking=0、未解决 Warning=0，候选方案审查通过。
预算-only 收拢须跟踪受现有 timeout/race 约束的 callStructured Promise，不等忽略取消的 SDK 裸 Promise。
reviewer 没运行尚不存在的预算门测试；这不是实现验收或 GitHub approval，策略仍待用户确认。

尚未补实施反例、改 runtime/repository、安装依赖、运行模型、typecheck/lint/build/E2E、创建 PR 或跑候选 CI。
目前的本地证据仅为盘点/文档检查；主干 CI 是已有前置的证据，不是 C2b 验收。
后续须先确认新策略及 repos.ts 最小交接，再按 spec 先反例后接线、独立最终 diff review、专属完成收据和 PR/CI。
停止边界保持：不合并、部署、生产迁移、历史修复、分支/worktree 清理。

## 后续授权与基线更新

用户随后确认最小预算契约与 repos.ts 一个只读接口，进入反例与实现。
独立实现评审新增 relay 跨任务失败污染反例后，用户“请按照建议的顺序继续”确认
relay-recovery.ts 最小文件交接及继续至 PR/CI。没有扩大合并、部署或数据操作授权。
2026-10-05 已 fast-forward C2b 分支至 D1 #411 合入后的 main `4e09ec93923a0d7bece2b282045a18c98eb3a1c8`，
精确 main CI 37219844193 success。C2b 未修改 D1 连接/迁移/启动文件，也未操作其 worktree。
最终本地结果、限制与独立复审见专属完成收据；本启动收据不作为实现或生产验收证明。
