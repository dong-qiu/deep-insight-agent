# D6 / TD-19 本轮文档核对收据

日期：2026-10-06（Asia/Shanghai）。[验收 spec](../plan/specs/d6-documentation-evidence.md)；[差异清单/20项台账](d6-technical-debt-ledger-2026-10-06.md)。
此收据记录提交前的实际工作；候选 CI/远端复核在首次提交时尚未取得，不预签成功，后续写入同一 PR 最终交付摘要。

## 范围与隔离

首次 fetch 最新 origin/main 为 `6eabc5f671073c377200f7551daf8a143d333989`，从该提交创建
`docs/d6-td19-evidence` / `/Users/dongqiu/Dev/code/insight-agent-d6`，未整分支导入旧并行计划。
不需要应用运行配置，未复制 `.env.local`、`.env.development.local`、数据/SQLite/WAL、原文/报告；未打开业务库。
只读核对其他 worktree 的 status/HEAD 与进程 cwd，未读会话正文/凭据或把 Git 干净当作释放。
主 worktree roadmap/ADR 与四份 Brief 专属未提交文档保持原 Session 所有；Brief density 专属收据和 source-map audit lockfile 修改不归入 D6。
用户明确交接 README、operations、technical-debt-remediation、L2-workflow、architecture 五份文档后才修改；另外只新增 D6 专属 spec/台账/本收据。

## 只读证据盘点与文档修订

读取实际主干 AGENTS、README、roadmap、治理实施计划、运维手册、直接相关架构/ADR-0017/0026/0037/0038 与 L2/L3。
逐切片读取专属 spec/收据/最终 PR 摘要，初查台账匹配37个 PR 的实际 mergeCommit、精确 main push CI 的 headSha/event/run/attempt/jobs，并确认提交均为本轮基线祖先。
首次元数据核对完成时间 `2026-10-06T11:43:01Z`；后续#420补核时间见台账，现共38个PR/main精确绑定；旧 Actions 结果未重跑，未重新归档所有历史原JSON。历史性能数字来自专属收据/最终 PR，不冒充本轮独立测量。
指定旧并行 worktree HEAD `7342576` 的未启动/下一项C5状态已过期，只用于需要核实的线索。
未找到独立原始20项审计全文；保留这个来源缺口，原治理实施计划编号和验收表不改。

主要修订：README 区分快照输出写入/破坏性本地恢复、Docker本地与生产、导航与CI路径；operations 区分旧恢复诊断/当前阻塞/生产许可，标注成本回填实际打开方式与P1休眠；架构CI与C2/C3成本口径、历史备份目标对齐；L2补已有实例前置、SSM读取与trigger补跑标签；技术债计划补当前各切片状态及专属证据入口。
最新 main 的 L2 已停用 rsync；主 worktree 旧版本的过期建议没有被误归为本轮新修复。
没有业务实现、脚本、CI、schema/migration、package/lock、模型/prompt/baseline/dataset 改动。

## 本地验证

本轮使用仓库 `ops/ci-docs-check.mjs` 的 `checkDocuments` 检查全部8个候选Markdown的格式/标题、链接/锚点与收据结构，含指向被修改文件的入链；两次检查均8 files通过，重要修正后提交前再次复核。
检查器 API 需要文档输入投影，**不表示完整 PR 分类为 docs**：实际白名单只包含普通 docs/verify 和 docs/plan/specs 文件，README/operations/architecture/skills 令本PR走 full。
`git diff --check`通过；通过`git show HEAD:<治理计划>`与当前文件的“顺序和验收清单”区段精确字节对照，确认原编号/验收表未改；文件范围仅8个Markdown。没有应用行为变化，不在本地安装依赖或运行应用测试/typecheck/build/A1。最终 workflow 将按 full 自动执行既有应用/typecheck/Docker与确定性门；它不能代替文档事实核对。
本地文档工具 Node v25.9.0，不冒充 Node24 应用验证；CI环境以实际workflow为准。
Eval不适用；没有付费请求，不将文档PR盖成AI实现skip证据。

## 独立审查

应用仓库 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)，独立新上下文只读 reviewer 针对完整基线到候选差异与 D6 验收。
核对逐状态证据、切片/整体/生产层级、当前工具入口、历史失败/收据时间语境、取消P1边界、未知范围及共享文件归属。
独立 reviewer `d6_independent_review` 最终结论：低风险（纯文档、含运维指引），通过；Blocking 0 / 未解决 Warning 0 / 未解决 Suggestion 0。初审发现3类重要 Warning：§6.1残留旧replay启动许可、§14裸compose配置生效、预算账单/日月重置口径；均修正并定向复查通过。E420表格空行建议也已修正。最终自查把architecture安全表残留的账号级联/30天备份清除与全源许可表述改为未验收目标/独立准入；reviewer对这两行定向复核通过，未改历史收据。
reviewer独立执行8文件checkDocuments与`git diff --check 86d824f`通过，确认原验收表字节未变，交叉核对38组PR/main元数据及Git祖先无差异；没有运行应用/运维/生产/模型或改文件。未代写GitHub人工approval。
提交后还须独立核对远端完整diff/摘要/候选SHA与所选CI身份，实际留痕追加PR。

## 证据与限制

D2/C4b/D3 本阶段收口但 TD-12/14/15 部分完成，性能warning保留。
D7 #419 候选CI成功，而精确 main run 37437928802/attempt1 在 source-map-js 供应链审计失败；原失败保留，不由D6修依赖或重跑旧作业。其他Session后续#420已合入 `86d824fd5fbe12006679a02cebcc877f71493f73`，其精确main CI37458872550/attempt1/full success；D6分支正常ff同步该最新main，不把后续成功替换原#419结果。
C1机制/合成恢复/生产完整恢复分层，TD-09不能关闭；当前生产revision/完整恢复、实模型耗时/费用/吞吐及D3生产/并发/冷缓存/HTTP/browser性能仍未知。
发现 cost-backfill 可写打开、snapshot覆盖输出/缺生产拒绝及restore旧提示等工具缺陷仅记后续，不在本任务修改实现。
roadmap/ADR未交接建议、原始审计全文与D7后续证据复核保留；因此本轮独立文档可交付，TD-19整体不能关闭，不声称全部当前入口无剩余冲突。
P1 dormant/取消任务不重启；未来另立任务/治理准入，历史证据和当时测试结果不改。

## PR、CI 与停止点

按 [交付证据流程](../plan/specs/pr-delivery-evidence-workflow.md)先完成本地核对和独立审查，再正常 hooks 提交/推送并建 Draft PR。
首次提交的本收据不填尚不存在的CI通过结果；最终候选SHA/base/tested SHA、run/attempt/scope/必需与所选下游、artifact身份/hash/期限及独立远端复核结果追加PR摘要，避免只为CI URL移动head。
本PR纯文档内容但full路径；若其他纯文档PR按docs分类，应用/Docker/镜像正常skipped不构成失败，也不构成新应用或生产证明。
最终候选CI若有外部已知供应链失败，应如实记录，不能用文档检查消除main缺口或在D6顺手修复。后续主干变更只在自有分支正常集成，并重新核候选/影响范围。
完成PR/CI后停止等待合并授权；不合并、部署、生产访问、执行运维/恢复/修复/迁移、调用付费模型或清理分支/worktree。

## 回退

正常文档 revert PR 即可撤回本轮文档；不涉及业务实现、数据库/报告、生产配置或恢复。历史专属收据不删不重写，共享文档未提交内容不代交。
