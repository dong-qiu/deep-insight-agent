# D1 / TD-11 前置盘点、方案与保护测试收据

> 历史时点收据：下文保留实施前失败与当时待确认状态。用户后续协调确认和修复后的实际结果见 [最终实施收据](d1-database-lifecycle-2026-10-05.md)。

范围：A 阶段，只读盘点、隔离、专属 spec、冻结基线与反例。**D1 未实施、未完成，没有 PR/候选 CI 或生产证据。** 用户明确选择“尚未确认，先完成前置工作”；共享文件交接未确认，B/C 阶段不执行。

验收与调用图见 [D1 spec](../plan/specs/d1-database-lifecycle.md)。测试见 [D1 protection](../../src/lib/db/d1-database-contract.test.ts)，冻结契约见 [main v48 fixture](../../tests/fixtures/d1-main-v48-database-contract.json)。

## 现场事实与隔离

已 fetch origin/main，基线 `c7648986d96e040dcad8c7e6dd01e75759c2bbee`：

| 切片 | 合入事实 |
| --- | --- |
| D4 #404 | merge 142b1e38c0f07d0ff67d80611c2681a5ef11ffc8，2026-10-04 09:34:28 UTC |
| 认证 #409 | merge 823b6d875ceecc66dc35ff4ef37a8699aadbec17，2026-10-04 08:58:55 UTC |
| C3 #410 | merge c7648986d96e040dcad8c7e6dd01e75759c2bbee，2026-10-04 15:32:53 UTC |
| 精确基线 main CI | [37213415190](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37213415190)，completed/success |
| 镜像发布 | 37213621307 success，只是发布状态，不是上线核验 |

已读 AGENTS、L0/L2/L3、architecture、technical-debt-remediation、generation-provenance、C3 spec/两个收据、D4 专属收据，以及恢复/删除、只读和 migration 现行规则、pre-pr-ai-review/eval-gate/交付流程。独立 refactor-plan 的 parallel-execution 只作协作参考，不合入其分支。

独立 branch `refactor/d1-db-lifecycle` / worktree `/Users/dongqiu/Dev/code/insight-agent-d1` 从该基线创建。仅复制 .env.local，0600，DB_PATH/DATA_DIR 隔离；不输出密钥，不复制 .data、SQLite/WAL、原文、报告或 .env.development.local。

主 worktree 的 decisions.md/roadmap.md 修改及四个未跟踪日报规划文件保持原样。worktree 盘点：C1 backup/identity-audit/restore-rehearsal、C3、refactor-plan、backup-interval、brief-extraction-probe、delivery-1/2/3 干净，brief-density 有专属进度收据修改；状态不证明会话结束。本机存在多个 Codex 进程，不能可靠映射文件归属。收尾 worktree 再盘点发现新建 insight-agent-c2b / feat/c2b-task-budget @ c764898，检查时干净；C3 工作区已不在该次列表中，这是外部会话状态变化，本会话没有执行清理。C2b 占用仍须明确交接，不根据干净状态推定释放。没有操作其他工作区或清理任何分支。

申请的 D1 接手范围为 index.ts、新连接/启动/兼容 bootstrap 模块及 provenance-migrations.ts 的职责拆分；schema.ts、repos/业务接口、runtime/预算、恢复/删除、package/lock/CI/Docker/共享文档不动。新反例表明 auth-reader.ts 和 local-bootstrap.ts 如需修复须补充交接。C2b/C1 当前占用尚未确认，不自行承诺它们的接口或完成时间。

## 实际契约与基线保护

- openDb 的 WAL/FK/busy_timeout、本地 schema/ensureColumn/v44兼容 trigger 与 orphan recovery 顺序保留；getDb 严格模式关闭 bootstrap，校验 latest ledger/deployment，再 raw→report→directions，成功才发布单例。
- 现有 startup gate 只查最新 ledger；runner 才逐项校验历史 checksum。保护测试明确这一区别，不擅自强化 gate。
- schema.ts 是事实源；C3 v48 不在 SCHEMA_SQL，不通过 app startup 偷迁移。
- 冻结 fixture 在任何 D1 实现之前由未修改 main 的真实 runner 生成，含 48 条 version/checksum 与 277 个 schema 对象；前 47 条另与既有 C3 独立 fixture 比对。没有以重构后的代码重新生成预期。fixture SHA256=`8db5364ae12c3f451edb68946bb1168a2dc26ea4a7d6294e9d77372975aa8290`。
- 用真实 ledger INSERT trigger 逐个停止 runner，生成 v0–v47 前缀，经 VACUUM INTO 合成文件再重新打开升级；全部最终 schema/ledger 与冻结基准一致，重复 runner 连 applied_at 与 user_version 都不变。
- 前缀来自当前基线 runner 的实际提交，不是所有旧发行二进制/真实备份；合成空数据不能证明任意生产历史数据升级。既有专项 legacy/v42+ 回归另行运行。

## 反例结果与未闭合边界

D1 新增 63 项测试：59 通过、4 失败。失败反例保留为严格验收，未 skip/xfail、未更改期望掩盖。尚未推送，不创建红灯完成 PR。

| 已证实缺口 | 真实测试与影响 |
| --- | --- |
| WAL 认证 reader 文件零写入不成立（v47/v48 两项） | 关闭 WAL 文件库后调用现有 readCurrentSessionUser；文件内容 hash 不变，但新增 -wal/-shm。readonly/query_only 不等于 sidecar 无写入；DELETE 离线快照三项零变化通过，不替代 WAL 验收 |
| runner BEGIN 抢锁失败后 FK 留 OFF（一项） | 真实 v12 文件、第二连接 BEGIN IMMEDIATE、runner busy_timeout=1；v13 foreign_keys=OFF 后 BEGIN EXCLUSIVE 锁错误发生在 try 外，未执行恢复 finally；DDL/ledger state 不变但 FK=0 |
| local bootstrap migration 失败泄漏连接（一项） | 真实 v47 文件加 ledger INSERT trigger 故障；openLocalBootstrapDb 抛错后所拥有连接仍 open。仅通过 pragma spy 捕获真实连接检查生命周期，测试 teardown 关闭该自有连接 |

不偷偷加 immutable reader（可能改变 live WAL/会话撤销可见性），不把要求降级成只查 SQL 内容，也不在未交接前修共享代码。三类缺口应在交接后明确作为边界修复或由用户决定范围；纯文件搬移不能自动满足全部验收。

## 本地验证

本地 Node 24.19.0 / npm 11.17.0。第一次 npm ci 误用默认 Node25，收到 engine warning；随后 Node24 正常重装并审计 505 包、0 漏洞，package/lock 无改动。以下均使用 Node24，无真实模型调用、云或生产数据库访问。

| 命令/范围 | 实际结果 |
| --- | --- |
| D1 d1-database-contract.test.ts | 59/63，4 项真实基线失败，exit 1 |
| 初始化、migration、认证 reader、C3 DB/runtime/SDK 集成、local bootstrap、report redaction（8 文件） | 95/95，通过 |
| jobs、jobs cancellation、relay cancellation、report cancellation、raw archive、C1 candidate audit（6 文件） | 50/50，通过 |
| npm run typecheck | TS7/TS6 app/tools 全部通过 |
| npm run lint | 通过 |
| NEXT_TELEMETRY_DISABLED=1 npm run build:e2e | 一次实际构建通过，22,146ms 单次观察 |
| npm run test:e2e:built | 6 文件 / 7 项通过，同一 C5 收据，additional_builds=0 |
| npm run test:browser:built | 原 D4 Chromium 5/5 通过，零重试，同一 C5 收据，additional_builds=0 |
| git diff --check / 两份专属文档链接 | 通过；共享 tracked 文件相对 origin/main 零差异 |

完整 coverage/ops、PR CI/Docker 未执行；本地 build/HTTP/browser 仅为未改实现的前置保护网可用性证据，最终候选仍须重新绑定验证。新增失败反例未解决前不宣称质量门全绿。上述既有回归均执行未修改的 main 生产路径，只证明保护网可运行。

## 独立评审与 Eval

新上下文方案 reviewer 按 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md) 只读审查：Blocking=0、Warning=2（WAL sidecar 与 BEGIN 外键边界），均已明确记录，不是通过验收。reviewer 用 stdlib SQLite 3.53.2 独立复现两类合成边界；主 agent 随后用仓库 better-sqlite3 的真实路径测试重现。方案可进入测试前置阶段，实施仍需交接。

另一个全新上下文 reviewer 已只读核对最终四个前置文件，并使用 Node24 独立复跑：59/63，4 个失败与主 agent 一致；全部 48 个真实前缀升级、历史 checksum、fixture SHA256、teardown 和文档链接通过。A 阶段审查结论通过，Blocking=0、新增 Warning=0、既有待闭合 Warning=3。build/HTTP/browser 数字由主 agent 执行，reviewer 未独立重跑，不伪称双重运行证明。最终实现 diff 尚不存在，不冒充完成评审。使用 [eval-gate](../../.agents/skills/eval-gate/SKILL.md)；当前无运行实现/模型/prompt/provider/引用/预算或评测语义变更，未盖实现 skip/pass，不运行无关付费 A1。未来若修边界或拆分须按最终 diff 和真实回归再判断。

## 下一阶段和停止边界

1. 确认 C2b/C1 文件占用并交接 index/provenance runner 与拟新增模块；如修现有反例，明确 auth-reader/local-bootstrap 归属和范围。
2. 保留所有失败反例，设计可保持现有业务契约的修复；再按 B→C 阶段实施，独立审查和完整验证。
3. 写实现专属收据、冻结候选、Draft PR、独立远端 diff 复核与 full CI；仅在此完成后等待合并授权。

当前停在 A 阶段，D1 未完成，D2 尚不具备 DB 模块实现交接条件；D2 只能先调查/spec。正式启动 D2 实现需 D1 对应模块合入及精确 main CI 成功后交接，不把前置 PR、镜像或合入当作上线。

没有合并、部署、生产 migration/恢复、历史修复或分支/worktree 清理操作。
