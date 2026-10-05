# D3 / TD-15：图谱下钻读取性能首切片

状态：本轮测量及不保留优化的决策已完成；最终 PR/CI 尚待验证。TD-15 仍部分完成。
基线：origin/main `1d8925f7559bc648a2be288f2e9977336a4e0d17`（main CI success）。
承接 [技术债计划](technical-debt-remediation.md)、[架构](../architecture.md)、
[D1](d1-database-lifecycle.md)、[D2 范围处置](d2-scope-disposition.md)、
[B4](evidence-reader-visibility.md)、[历史归档](legacy-archive-reader-integrity.md)、
[现行性能门](report-reader-performance-budget.md)。

## 盘点与窗口

| 用户路径 | 实际接线与增长风险 | 已有证据覆盖 |
| --- | --- | --- |
| 报告库 | ReportsPage → queryReportIndex + 三类 distinctIndexValues；JSON/FTS 筛选，默认 100、最大 500；排序/序列化在服务端 | reports 测试；未有完整库页性能基线 |
| 报告详情/引用 | getReport 读取 md/html、visibility；reportArchiveGap、neighbors、followups；admin 才有 pass/blocked 下钻 | P0c v4 微基准只测 getReport；不能代证整页、HTTP 或浏览器 |
| 图谱/阈值 | GraphPage → buildTopicGraphData → loadTopicEntityRows；batch.created_at 下界；批量 effect、同请求归档去重；完整候选装配后客户端阈值 | graph/B4/D4 正确性；图装配与全主题正文读取仍待测 |
| 实体/边侧栏 | ForceGraph → /api/graph/drill → insightsMentioningEntity/insightsCooccurring → loadTopicInsightsFiltered → rowToInsight → groupDrillInsights + reportLinksByInsight | 每个可见 insight 单独查 citation；候选实体先筛、归档门保持；所有 report 链接与 occurrence 保留 |
| 线索/机会 | listTechLeads/listTechnologyOpportunities 已批量查 evidence 后过滤再限数；OpportunitiesPage 再循环 listOpportunityLeads/listTechLeadEvidence 并重复读统计集合 | B4 tests/browser；同请求 sourceCache 不能消除重复 SQL，暂不实施 |
| 管理看板 | listRuns/聚合 cost/source health + recent report/selection diagnostics；metrics/details 另有 tenant/UTC 有界查询 | p1-metrics-capacity-v4 的 EXPLAIN/容量门；不代表普通 admin 整页 |

保留主工作区 Brief 的 roadmap/ADR 未提交改动；独立分支/worktree。
C1 保留 schema、发布/删除、恢复、启动与 ops；Brief 保留 analyzer/report-gen/reports/report-review。
C3 的 unknown/partial 与 Run.cost 兼容来源、C2b transport 门、C4b checkpoint 身份不变。
D2/TD-12、C4b/TD-14 只是阶段收口，整体仍部分完成。初查未见 D7 活跃实现。
拟窄窗口 graph.ts 与 analysis.ts 引用投影入口；发生重叠先取得逐文件交接，之前仅新增 D3 专属测量材料。

## 可重复测量计划

默认全部合成数据，临时 SQLite 与 v1 归档；无生产数据、网络抓取或付费模型。
固定 fixture v2：3 主题（目标/其他/空），目标规模 50/400/1200/2400 洞察；同表另有 1/4 的其他主题记录。
6 个时间批次（旧、恰好下界、相同时间、较新）；重复 statement、共享内容、每条 3 引用、绑定第 2 引用；
实体关系覆盖节点、边、其他实体；固定混入 blocked、无 check、legacy、reader_eligible=0、missing、
corrupt、pending、manifest 错配与历史 plain archive。合成归档正文约 4 KiB；安全反例测试另覆盖不可读/符号链接。
不截断候选、不去掉 audit、pass/support、raw 三方绑定、quote 可达性或报告 visibility。

主计时层是同步服务端 reader：从调用 insightsMentioningEntity/insightsCooccurring 起到返回完整 Insight[]；
另测 API 等价 payload 路径（reader + reportLinksByInsight + groupDrillInsights + JSON.stringify）。
后者不包含 middleware、认证、TCP、NextResponse 或浏览器，不称 HTTP/整页提速。
API/HTTP/浏览器仅验证接线和权限；若没有实测其耗时则明确未测。
分段诊断用 DB statement 执行次数、执行耗时、EXPLAIN QUERY PLAN 和完整 reader 墙钟；
instrumentation 不用于主计时。输出计数/hash/时间与查询模板，不输出正文/配置/敏感端点。

每规模/条件 3 轮；每轮各路径预热 10 次、采样 40 次，交替 A/B 顺序；保留所有轮次。
P50/P95 用排序后 nearest-rank `ceil(p*n)-1`，每轮分别报告，汇总为轮次分位数的中位数。
单样本是一次完整调用，不使用 25 次平均冒充请求 P95。
同进程、同静止数据库连接、同 fixture、同 DATA_DIR，无并发写；主结果是热 SQLite/OS 缓存。
额外首调用记录只称 first-read（初始化后，OS 缓存未知），不称物理冷缓存或 P95；不驱逐系统缓存。
记录 Node/npm/SQLite/OS/arch、git base/候选、源码 SHA256、fixture 描述/hash、归档数/字节、条件及每个原始样本。
冻结基线从上述提交取得 graph.ts/analysis.ts 字节，隔离副本仅调整相对 import，记录原始 hash；
两实现使用完全相同的真实 evidence/context 与报告 visibility 门，结果深比较/hash，相同数据/缓存条件。

## 选择与验收

1. 先在原实现跑保护测试、冻结结果，再实测查询次数/计划与分段开销；独立 reviewer 审查计划。
2. 候选只批量读取通过现有全部安全门的 insights 的 citations，400 个 ID 一组，仍按 citation_index 排序；
   不改 insight 的 rowid 顺序、绑定 index、speaker metadata、occurrence 和 report links。
   rowToInsight 可接收已读 citation rows，默认调用保持现状；其他 repository 不批量重写。
3. 正确性：固定 reader/API 集合、完整 DTO、排序、重复折叠/每条 occurrence、graph 计数/边/阈值不变；
   空态、since 下界/同时间、同分值、历史与失效证据 fail-closed；query_only + total_changes/文件 hash 证明零写。
   401/已撤销会话/角色由真实 HTTP 与 D4 browser smoke 保持，来源链接不代替历史原文。
4. 新路径没有现成性能阻断预算：建议首切片以等价 + citation 查询从 N 降到 ceil(N/400)，
   且 400/1200 规模服务端 P50/P95 收益明确、无持续回退作为保留依据；这是切片选择标准，不替换 CI 门。
   收益不清晰或复杂度明显时撤回实现，只交付全部测量与理由，不循环挑绿。
5. 不增加 schema/index/迁移/缓存平台/分页；不夹带 D2 拆分、D7 ID、AI、预算或历史修复。
6. 受影响 DB/API/页面 tests、TS6/TS7、lint、build、HTTP E2E、D4 smoke 和现有 reader/metrics 性能门；
   最终独立完整 diff 审查、PR 候选 CI 证明。eval-gate 以真实路径回归判定，不拿 A1 代证。

## 收口边界

本轮至多完成图谱下钻 citation N+1 首切片；报告库/详情、图装配全量正文、机会循环和 admin 全页
及并发/物理冷缓存/生产分布/浏览器 P95 均不自动关闭。PR/最终 CI 后停止，不合并、不部署、不清理。

## 独立计划评审后的冻结补充

- 四条件：Atlas 节点全部历史、Atlas 节点 since=`2026-09-01 00:00:00`、Atlas/Beacon 边全部历史、空主题。
- 每 12 候选固定 3 valid、1 blocked、1 unchecked、1 legacy、1 ineligible、1 missing、1 corrupt、1 pending、1 misbound、1 plain；有效 3 条共享 1 内容。6 批循环，后 5 批在窗口内。
- 7 份报告引用完整 expected 集；4 份 done 正常链接、1 done redacted、1 done delete_pending、1 generating，另以保护测试覆盖 non-done。
- fixture 直接创建新临时 DB：schema.ts 基础表与 insight 当前追加列、raw effect 读投影及相同 partial index、实际 lifecycle schema、redaction 读投影。无 migration runner/startup/修复；辅助表仅覆盖读字段，不宣称完整生产 schema/启动测量。
- expected IDs 由固定合成分配规则预先确定，独立断言第二绑定、三引用、group multiplicity、完整正常链接、图计数与边；先在原实现通过。
- 独立通过-ID 边界 0/1/399/400/401/800/801，不将主题候选数当作批量 ID 数。
- 每次完整 reader 都新建 evidence context；成功后缺失/损坏/不可读/符号链接的下一调用必须拒绝。
- frozen graph 明确指向 frozen analysis；原始、改写字节和 import mapping 留痕；共同安全依赖与指定 base 字节一致才允许运行。
- 保留判断预先固定：400/1200/2400 的非空条件逐轮列出 reader 和 payload 的 P50/P95 绝对/相对变化；若两条较大规模路径的 reader 与 payload 汇总 P50/P95 未至少降低 10%，或多数轮回退，收益不明则撤回。50 与空态单列，不用总体平均掩盖回退。本判断是合成切片选择准则，不新增/放宽 CI 性能预算。
- first-read 固定 baseline first，正确性检查之前；OS 缓存未知且先运行者影响后运行者，不能用于公平收益结论。
- 2026-10-06 已收到旧收口/Brief 与 C4b 会话回复：不占用 graph.ts/analysis.ts 窄窗口；保留 C1 与 Brief 其他文件，不推定整目录交接。

## 本轮选择结论与复现

固定一次正式 A/B 后，非空大规模 reader P50 改善约 7.4%–9.4%，P95 并非全部达到 10%；
因此没有达到预先固定的保留标准。生产 graph.ts/analysis.ts 已恢复基线字节，只保留离线试验补丁。
不换热点、不放宽标准、不重跑选绿；其他读取热点留待有独立证据的后续切片。

- `npx tsx evals/d3-reader-benchmark.ts evals/out/d3/reproduction.json --trial`：临时复制指定基线并在 `.cache/` 内应用离线补丁；不改生产源码、不读取配置或 DB_PATH。
- 不加 `--trial` 时比较冻结基线与当前生产 reader，当前分支为 A/A；用途须明确，不能作为该优化的 A/B。
- 完整正式样本/查询计划/源码身份已保存在 `evals/fixtures/d3-citation-batch-measurement.json`，所有三轮原始样本与失败方向保留。记录的是当时临时生产候选；最终离线补丁的重建 hash 与该候选严格匹配。
- 工具最终加了离线复现入口与显式 TS 类型；这不是另一次测量，不把最终工具 hash 冒充当时 runner hash。
- 原实现与离线候选精确边界/DTO等价、真实 production reader/API wiring、下一请求归档失效及零写保护保留在 D3 专属 tests；真实 HTTP/权限/页面交互另由隔离服务证明。

该性能试验是合成热缓存、静止库的局部结果；未验证生产分布、HTTP/浏览器性能、并发或物理冷缓存。
收据见 [D3 测量验证](../../verify/d3-reader-performance-2026-10-06.md)。本轮以 PR/候选 CI 为停止点；未授权合并或上线。
