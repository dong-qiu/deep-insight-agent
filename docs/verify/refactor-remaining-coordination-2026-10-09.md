# 剩余重构：状态、归属与接线前置核查

## 范围与基线

2026-10-09 本轮新增专属收据由当前协调者独占。只读核查、契约整理和证据保全已执行；R1–R8 源码未修改，三主台账未接管。本文是 R9 的独立增量，不关闭剩余工程或原 20 项，不替代原负责人交接。

重新 fetch 后 `origin/main=f61c73164907af21d57c1c702cb2351dafa151d4`。共享主工作区仍为其祖先 `65c5a6b4fe3e0089f6be5b66937fedf0d3f8c640`，落后 68 个提交，未移动它。本轮新协调 worktree 从精确远端 main 创建；必要本地配置复制后设为 0600，并绑定该 worktree 的独立 DB_PATH/DATA_DIR；没有复制业务数据。

本轮三个非协调 Agent 分别核查归属、R1 当前状态和最小维护契约，未写现有源码。既有 worktree 的只读、非原子盘点为 73 个，14 个含未提交改动，共 38 个状态条目。文件内容、私有原件、分支及 worktree 均保留。干净、已合入、Agent 已结束不等于释放归属。

## 精确历史身份重新核验

以下是本轮重新读取 GitHub 精确 attempt API 的结果，不是重跑验收：

| 对象 | 受审 head / tested merge | 合入 SHA | CI / attempt / 结果 | 证明范围 |
| --- | --- | --- | --- | --- |
| [#463](https://github.com/dong-qiu/deep-insight-agent/pull/463) | `570ec795cfbe9e9581f7e3533bb30229daafb74a` / `1168a4842f38289b10500b0862eb8502919db14f` | 无，OPEN / Draft | [37807152130](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37807152130) / 1 / success | 旧候选 CI；Blocking 1、Warning 4 仍保留 |
| [#464](https://github.com/dong-qiu/deep-insight-agent/pull/464) | `c5ee920a6a58701a2a0c75ca64c698f2f339c47c` / `3730017aa88dac6a43a1da1b782911e0379f05b7` | `46612863dde8508cd5f10b2c13184e90fc00e379` | [37809289491](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37809289491) / 1 / failure | 原 main 的 no-EOF native 失败，659/660、零 skip；保留失败 |
| [#465](https://github.com/dong-qiu/deep-insight-agent/pull/465) | `7d04bd4d683d46e6ae1d3547ce7492512f63cf38` / `84d759fcf0126873c4466afef2475921a28c4f04` | `3ed78338903523b2f9816d0312675f64816bf9d4` | [37816672359](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37816672359) / 1 / success | 最后完整应用验收；不覆盖 #464 原失败 |
| [#466](https://github.com/dong-qiu/deep-insight-agent/pull/466) | `5ad18eb726936d856bf6a4dfe817f469f313d980` / `8744b4f57085739a2c523deb6aebb41dd68048bd` | `f61c73164907af21d57c1c702cb2351dafa151d4` | [37818794922](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37818794922) / 1 / success | 文档验收；不证明应用、Docker 或镜像 |

本文新增候选的受审 head、tested merge、PR/main CI 和合入 SHA 应由本轮加性私有交付索引分别记录；在其发生前不预填成功。

## 任务—文件—owner—依赖—验收—授权矩阵

归属事实源为续批 `coord/final-retained-ownership-v2.json`、`completed-deliveries-v2.json` 及封存索引明确引用的 `handoff-search-v3.json`。前者明确 `all_owners_retained=true`、`normal_git_pr_meta_authorization_releases_sources=false`。本轮用户也未确认原 owner 是否释放；其“不确定，请核查”答复不是释放。

| 任务 | 文件及历史 owner | 依赖与限定验收 | 当前写入归属 / 授权 |
| --- | --- | --- | --- |
| R1 | executor_b：`evals/d7-s2a-old-head-{bridge,signatures}.ts`、`evals/d7-s2a-old-head-bridge.test.ts`、`docs/plan/specs/d7-s2a-old-head-bridge.md`、`docs/verify/d7-s2a-old-head-bridge-2026-10-08.md` | 不可变完整控制快照；安装 cap=0 后外部改值仍零发送；真实 AbortSignal；默认 tmp canonicalize；未知请求 fail closed；全部原拒绝规则保持 | 明确未释放；旧两轮修正已用尽，保持 Draft。新窄切片先取得逐文件移交及重新冻结，不以更换 Reviewer 规避轮次 |
| R2 | C1：`ops/backup-db.mjs`、`ops/backup-integrity.mjs`、`ops/crontab` | 真实 CLI 首效应前准入；拒绝不 mkdir/写开 DB；异步 backup/复制/rename/manifest/轮转/清理的取消、unknown、重启和幂等；合法隔离正例 | 三文件未移交；正例许可合同也未冻结，不伪造 ready/hold/epoch |
| R3 | C2b/C3：`src/lib/db/model-usage.ts`、`src/lib/runtime/model-usage.ts`、专属测试 | 固定同步提交合同；真实事务、迟到观测、撤销与 sticky failure；unknown/partial/真实费用不归零；共享 jobs 接线留 R6 | runtime/DB commit 源保留；精确现 owner 与释放待确认 |
| R4 | `src/lib/db/raw-archive.ts`、专属测试；原 owner 未精确确认 | 固定提交合同；intent/attempted/文件发布/finalize/reconciliation；失权不发布或 reader_eligible；保留恢复依据；collector 外层事务留 R6 | DB commit 源保留；owner 和释放均缺 |
| R5 | C1/Brief/D3 共享边界：`src/lib/db/reports.ts`、专属测试；anchored 还涉及 `integrity-publication.ts` | 固定提交合同与 R4；ordinary/anchored 保存及恢复；validator/raw/review 白名单、pending/unknown、幂等；不拆 TD-12 | 现有共享文件未移交；新增相邻文件范围也须冻结 |
| R6 | D1/C2b/续批 B/Brief：`startup.ts`、`cancellation.ts`、`jobs.ts`、`writer-admission.ts`、dispatch/core/HTTP、`collector.ts`、`report-gen.ts`；相邻调用方按需冻结 | 唯一 owner 串行 startup→HTTP/dispatch/jobs→业务调用方；准入先于 open/mkdir/reconcile/seed；验证真实消费、lease/fence、迟到/失败反例 | 未取得共享源逐文件移交；不能只传控制对象 |
| R7 | 原 C2a/runtime：`ops/generation-dispatch-worker.mjs` 的 `DISPATCH_DRAIN_TIMEOUT_MS`；followup route 仍 B 保留 | 仅盘点一项候选：非有限/溢出/超过 Node timer 上限拒绝；保留默认 130000 及合法转换；实际子进程入口 mock fetch，未知路径不发送 | 具体语法及合法边界尚待冻结，文件未移交；不改 followup rate；不重复 #447/#461 |
| R8 | C1/A2/A3/executor_a：备份/恢复与维护运维实际消费者，具体文件尚待冻结 | R2 和提交合同稳定后串行；消费身份、完整性、兼容、恢复依据与 unknown；区分隔离 transport 与真实远端终止 | 原源保留，依赖未满足；不恢复 DB、逆迁移或启动旧漏洞镜像 |
| R9 主台账 | 历史 root：`docs/verify/d6-technical-debt-ledger-2026-10-06.md`、`docs/verify/refactor-coordination-2026-10-08.md`、`docs/plan/specs/technical-debt-remediation.md` | 精确版本、执行门、原件 hash 及限制逐项绑定 | 未正式移交；本轮仅写全新专属收据和私有证据 |

源码变更的正常 feature branch、隔离验证、提交/push/PR、独立评审及全部门通过后的 squash 合入已授权。此授权不替代文件移交。当前没有满足归属条件的 R1–R8 实现片；R9 专属收据可以独立推进。

## 最小增量契约及实施前置

复用 [A3 writer 协议](../plan/specs/a3-writer-admission.md)、[提交 fencing](../plan/specs/a3-commit-fencing.md)、[staged 终态](../plan/specs/a3-staged-terminal.md)、[C3 usage](../plan/specs/c3-model-usage-persistence.md)和 [C1 备份](../plan/specs/backup-recovery-integrity.md)。下表冻结本轮必须保留的边界；具体新增固定消费者接口仍未设计完成，不能称实现方案已通过。

| 边界 | 最小约束 |
| --- | --- |
| 准入 | 首次目录、写入式 DB 打开、初始化/reconciliation/seed、claim/Run 或外部 dispatch 前验证。严格配置损坏不得降级。 |
| 身份 | 完整 root/marker、operation/owner/fence/revision、worker/generation/task 和真实 DB 物理身份绑定；dispatch 六字段 claim 保留。可变控制保存不可变 primitive 快照，既有 signal 对象仍实时取消。 |
| 提交 | sidecar 单次 check 不证明 fencing；固定 registry→stage（适用时）→business 锁序，覆盖真实同步外层事务和 COMMIT 返回；不得从已有业务事务反向申请锁，不持 SQLite 写事务跨 await。 |
| 取消与费用 | lease ownership、首个 C2a cancel/deadline、C3 sticky failure、budget 优先级保持。取消拒绝业务结果；真实迟到调用及费用保持实际/unknown，不改成零。 |
| unknown | 区分 not_committed/committed/unknown。业务 COMMIT 已返回后 sidecar 失败不称 rollback；无 catch→failed 第二次提交、自动重发或 legacy fallback。 |
| 重启 | 不用旧 task/claim、clone、inspect 或 snapshot 重建 capability；不清 hold/unknown、不重置 epoch、不删恢复依据。 |
| 证据 | base、受审 head、tested merge、合入 SHA、精确 CI/attempt、真实执行入口与原件 hash 分别绑定。部分覆盖不签 ready/quiescence/生产许可。 |

当前 `FixedTerminalDispatchDriver.commit(claim,outcome)` 只处理 dispatch 终态，不能授权 usage/raw/report 写入。R3/R4/R5 前须由唯一共享负责人冻结具体固定同步消费接口；各 Agent 不能自行创建 gate 或泛化 callback 框架。R2 也不能从当前 owned-drain 的 held/all-ready=false 取得正向 backup 许可。这里存在工程合同缺口，不能归类成“仅差授权”。

文件交接后调度顺序：R1 窄修复与 R2 合同准备；共享接口先冻结，再 R3/R4 两个独占范围并行；R5/R7 并行；R6 由同一 owner 串行，另一 Agent 准备 R8 独立验收；最后 R8 组合验证、R9 主台账正式移交。每个高风险实现有两位独立非作者 Reviewer，资源密集验收与合入排队；未修 Blocking 不反复评审。

## R1 恢复交接包

最小下一步是明确移交上述五文件；不需移交整个旧 worktree、私有证据或旧 S2a head。交接记录须列出原 owner、接收 owner、精确文件、冻结 head/hash、未提交改动如何保留、释放范围及仍保留范围。原 owner 无法确认时，需要用户针对这五文件明确授权恢复交接；本轮没有推定取得该授权。

旧五源与封存一致，head 仍 `570ec795...`，没有发现新修复。bridge 继续保存外部 syntheticLimits 引用并回读 root/signal；冻结 RequestInit 不能冻结控制。原 cap=0→改为2 的反例有 HTTP1 且 finish 成功，仍是 Blocking；默认 Darwin tmp canonicalize 仍为 Warning。旧受审结果及其两轮限制不改签；恢复交接后仅冻结新的不可变控制/默认目录窄增量，不重新审查未修复的同一旧 Blocking。

恢复移交后，本轮不得扩大评分、dataset、baseline、模型或质量判定。旧 S2a `235045d6424640d79c79874a403749c6bd17b823` 的真实质量仍未验收，新 bridge mock/隔离测试不能补签。

## 原 20 项与保留条件

状态沿当前主干和两次交接保持；本轮没有源码切片完成或整体新增关闭：

- 既有范围关闭：TD-01、02、03、05、06、07、08、11、13、16、17、18。
- 部分完成：TD-04、09、10、12、14、15、20；本文不关闭这些项。
- TD-19：既有本阶段完成，整体未关闭；本轮只新增独立收据，主台账尚未移交。

TD-12 延期模块、TD-14/15 性能实验、dormant P1、独立 Brief 和历史数据修复不重开。TD-14 一项人工裁决 pending，AI 只能建议；TD-14/D3 原材料现位置缺口仍由原负责人提供精确入口，不广搜或重跑冒充。历史 C2g HTTP403 的潜在外部请求与发送/费用未知保留，不宣称重构全阶段请求或费用为零。

`safe_rollback=null`、`deployment blocked`、现有 hold 与 #435 硬阻断保持。旧冻结镜像 revision `4477412a3e2b1cb2764fb4357f2284e73952af67` 不含后续维护代码；旧矩阵不作为新源码/新镜像验收。隔离 SSM transport 不证明真实远端全部工作终止。本轮真实业务模型预算 0，未执行生产访问、部署、备份/恢复/迁移、cron 或真实业务 provider 调用。

## 证据与限定验证

本轮私有证据包标识 `refactor-remaining-20261009-063044`。原件只读，新增目录 0700、文件 0600；保存精确 PR/CI attempt API、job 元数据、非原子 worktree 状态和定向原件 hash 验证。绝不将密钥、数据库、原文或私人日志提交到 Git。

| 原件 | SHA-256 / 本轮定向核验 |
| --- | --- |
| 旧封存 `final-delivery-handoff-v1/index-v2.json` | `c2016383609c9da2e3954af2f2f138af6c9c7b1ef0dbd61830088c0e691f1a06`；62 个显式 path+hash 引用均存在且匹配 |
| 续批封存 `final-delivery-handoff-v1/index-v1.json` | `c1b3dcd8ef5a76ec2353c5a990a2fab3f8badd161f5e534ab0858c5d53fc19a6`；140 个显式 path+hash 引用均存在且匹配 |
| 归属记录 | `dd9fca64f568ece874c34d349cb09c82b0f5581637142563bd2abf37dcdee886` |
| 续批交付记录 | `cf50c596bedf11240f121a510f2779a307f61fc6d8b283f9fc54f49b54033f5a` |
| R1 mutation 原日志 | `f62580330af1b680c295883fb785c28dcf7e202e911e0cb5b7c046b5b34a100a` |

上述引用核验不递归重验每份历史产物，也不消除 TD-14/D3 精确原材料位置缺口。旧索引实际入口由续批索引明确指向 index-v2；起初猜测 index-v1 不存在是核查路径失误，不记作原件缺失。

本轮只改文档。Node 24.19.0 / npm 11.17.0 下 `npm ci` 成功、依赖 audit 为 0；真实 `ci-docs-check.mjs` 的 scope/link/anchor/format/receipt 门通过，`npm run typecheck` 的 TS7/TS6 app/tools 四项通过。独立 Pre-PR AI Review、命令结果和最终身份保存在加性私有索引。安装器的 prebuild-install 弃用与四包 allow-scripts pending 提示保留；本文验证不依赖 native 执行，没有据此声称 native/ops 应用验收。未运行 A1：本文未改模型、prompt、validator、来源、评测口径或应用行为。文档 CI 不作为新应用、Docker、备份 consumer、全 writer fencing 或镜像验收。

#465 最后完整应用 reader Warning 保留：ratio `1.2709109706940342`、delta `0.03190512000000126ms`，原双阈值下 passed=true；该 warning 未在本轮重测或被清除。#463 的 Blocking/四 Warning、#464 原失败、其他历史性能/review warning、缺证、延期和人工 pending 分别保留。
