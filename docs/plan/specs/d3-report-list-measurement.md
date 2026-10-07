# D3 / TD-15：报告库列表测量与取舍

日期：2026-10-07。基线：`origin/main@41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1`。
承接 [技术债计划](technical-debt-remediation.md)、[首轮 D3](d3-reader-performance.md)、
[首轮收据](../../verify/d3-reader-performance-2026-10-06.md)、
[D6 台账](../../verify/d6-technical-debt-ledger-2026-10-06.md)。TD-15 保持部分完成。

## 唯一热点、归属与问题

唯一入口：`src/app/reports/page.tsx` 的 `ReportsPage(searchParams)`。
没有报告库列表 API。链路为页面 → listTopics/listSources → 三次 distinctIndexValues →
queryReportIndex → rowToIndex → ReportCard。日期/重要性/FTS 排序、JSON 筛选在 SQL 中，
卡片截取、去重和 snippet 标记在渲染中。

列表读取发布时 report_index/FTS，按 done、永久 report redaction、lifecycle active/无记录过滤。
引用资格检查、当前正文与归档读取次数为零，这是
[B4 历史记录例外](evidence-reader-visibility.md#历史快照例外)；不把当前证据门加到历史列表上，
也不删掉必要 SQL 可见性门。详见 [历史归档](legacy-archive-reader-integrity.md)、
[架构](../architecture.md#报告索引项-reportindexentry)、[D1](d1-database-lifecycle.md)。

待验证问题：不随筛选收窄的三类全库 facet 聚合是否占主要墙钟？FTS、重要性排序及行/卡片装配
在不同输入/输出规模下谁主导？SQL 相关子查询不是应用层 N+1；sqlite_master 表探测的重复执行
不直接证明值得优化。报告/归档文件为零读取也必须以观测和反例确认。

worktree 清单、各分支相对 main 文件集合与当前 status 已核。Brief 保留 reports/report-gen 与共享
产品文档；C1 保留 schema、删除/恢复及架构，graph/planning/共享测试也不推定已释放。
没有可靠的所有 Session 活跃状态映射；用户作为协调者的回复尚未提供具体交接。
本轮仅新增 `evals/d3-report-list*`、`evals/fixtures/d3-report-list*` 和本 spec/专属收据，
生产文件、共享 fixture/test、package/lock、CI、roadmap/ADR/台账零修改。因无需共享文件写入，
继续默认报告库；如实现须修改共享文件，停止并说明冲突，不同时改测其他热点。

## 层级与环境身份

主测量调用真实页面函数，唯一替换其 getDb 为隔离只读连接，再以 React renderToStaticMarkup
执行真实 ReportCard/Link。esbuild 仅转换 TS/JSX，保存输入依赖 hash 与生成 bundle hash。
记录页面函数墙钟、静态 markup 渲染墙钟、包围两者的整体墙钟；等待 searchParams 使用已兑现
Promise。这不是 Next 编译产物、RSC 请求、认证/middleware/layout、HTTP、browser 或生产测量。

依赖从锁文件 npm ci；固定 Node24.19.0/npm11.17.0（初次误用系统 Node25 的安装警告保留，
采样前已用正确版本重新安装），记录 SQLite、OS/CPU/内存、git base/head/tree、锁文件及
所有实际 bundle 源输入与工具 hash。无需 .env，不复制本地数据，不联网抓取或调用模型。

隔离新库在工作树 gitignored `.cache/` 下创建，先通过真实 openDb + provenance migration runner
完成当前 schema，再合成 seed，FK/quick_check 校验、checkpoint 后切 DELETE、关闭 writer。
计时只用 openReadonlyDb（readonly/fileMustExist/query_only），不调用 startup/getDb/migration。
记录 fixture 构建、只读 open 和初始化后首次页面调用，但不作分位数或物理冷缓存/收益证明。
请求通常使用已初始化 getDb 单例；实际进程冷启动、启动协调与物理冷缓存本轮均不测。

## 固定合成分布与正确性 oracle

每库 report/index/FTS 行数 50/400/1200/2400，4 topic、8 source。
12 槽循环：8 done 可见（混合 active/无 lifecycle、有效当前原文和合法历史归档缺口）、
1 done redacted（含过期但永久隐藏）、1 delete_pending、1 generating、1 failed。
后两者有刻意模拟旧脏索引/FTS，不能由它们的更快失败构成收益。
redacted反例先插report/index/FTS，再直插合法tombstone（不调用会清除投影的replay），
保持v47提交trigger；不在已生效tombstone后插入index或禁用约束。
六个日期桶含 from/to 相等与同日 ties；同重要性以 date DESC 次级排序。
新旧 rep ID 混合且长度合规；重复 JSON 值、重复历史 insight 关系不产生重复卡片或 facet 值。
索引 tags/entities 各 6 项（部分重复），source_ids 2 项；FTS 合成正文约4KiB，约1/4含 raretoken。
FTS命中项按n%8固定含1或3次词，确保top-k反例有不同bm25分数，不能只验证全分数ties。
四类隐藏记录分别带独占source/tag/entity哨兵值，断言不进入facets；空结果仍返回完整可见facets。
合成分布不等于生产分布，输入/输出规模和通过/筛选/limit 比例分别报告。

固定六条件：默认 date desc、date asc、importance desc、q=raretoken（默认 relevance）、
topic+date inclusive+tag+entity 组合、q=absenttoken 空结果。页面没有 limit 参数，保持默认100；
reader 的 1/500 上限仅在保护测试确认，不虚构页面可返回500条。
oracle 在 seed 时按已知分配生成可见集合、独立应用筛选/日期/重要性排序；同日无 SQL 次级排序
时校验完整候选中每个入选项不劣于未入选项，仅允许截断排序键ties自由选，不发明唯一稳定顺序。
所有条件要求数量=min(100,完整合格匹配数)、无重复。FTS合格匹配集由seed规则独立生成，
额外SQL读取全匹配bm25分数（不限数），校验入选项排序及top-k边界，仅分数ties可自由选；
校验snippet并将页面结果与真实reader完整DTO对照，不能只以合法子集冒充正确的limit。

独立边界数据含 pass/support、blocked、unchecked；当前原文 valid/missing/unreadable/corrupt/
body-hash mismatch/plain archive。真实 current evidence reader 拒绝不合格项；已发布报告仅关联
历史上合格的引用，原文后来失效仍保留列表。blocked/unchecked 不装入已发布集合。
不调用模型或 mock 全部合格，不把历史报告可见当作新发布许可。

## 冻结采样与诊断

计划须先由独立新上下文 reviewer 审查，再实现及采样。每规模每条件3轮，每轮10次 warmup、
40次单完整调用样本，条件次序按轮循环平移，规模升序；所有样本/失败保留。
主样本无 SQL/FS/源码计时 observer；nearest-rank P50/P95，另报 min/max、IQR、MAD，
每轮分别统计，摘要为3轮分位数的中位数，不将120样本混为独立跨进程证据。
返回校验与 output hash 在墙钟之外；任何不等价/异常/非有限数立即拒绝整次证据，输出失败收据，
不能吞错或丢弃慢样本。

诊断在相同库独立进行：DB proxy 记录 prepare 与 get/all 执行墙钟、调用次数、返回行数、
逻辑返回字节和 EXPLAIN；SQL 执行计时包括 native 行 materialization，不能称磁盘 I/O bytes。
诊断 bundle 只加 rowToIndex 计时，包装页面所调用的 reader/facet/config 函数及可见性 SQL
片段构建；记录源码改写身份并验证与主 bundle 完整 markup/DTO 相等。
可见性 predicate 在 SQL 内执行，不能从 SQL 墙钟里可靠分离其逐行成本；片段构建计时单列。
FS observer 记录同步 readFile/open/stat 等调用、路径类别、bytes 与错误，import/setup I/O 不计。
非计时正控用真实归档读取和错误确认observer有效；测量前后校验DELETE库hash/mtime、
sidecars与total_changes，以及归档/报告文件hash与权限，检查均在墙钟外。
其余页面/JS成本只能报 residual，分项有嵌套不得简单相加代替整体。

每条件另做10次诊断 warmup、40对 plain/observed 交替（配对先后每次倒置），主基线先完成。
记录观测开销绝对/相对中位差、输出等价；>5%或>0.1ms 标 instrumentation warning，
始终不把诊断墙钟当主基线，负差也不称 observer 提速。
性能期不并行任何本任务测试/build/coverage；记录本机负载/活动重负载进程名称，无系统缓存flush。
出现已知 build/coverage/test 重负载即暂停；已采样轮保留但标无效，不选绿重跑。

## 噪声、停止与决策准入

若3轮P50 max/min>1.15或某轮P95/P50>1.5，条件标 noisy，仍列全部样本，不能给确定收益结论。
错误/输出变化/写入/源身份不一致立即停止；已知负载污染停止采样；不改 warmup/n/阈值来挑结果。
每条件仅一次正式计划；任何修订须留原因、版本及旧失败，重新独立审查。

本轮无 A/B 优化、无分页/索引/缓存/减少证据验证。瓶颈优先级以主墙钟绝对耗时、诊断占比、
规模增长和正确性风险综合判断。若后续提候选，至少在1200/2400两规模同一非空条件上，完整
入口 P50 与 P95 均改善>=10%，每轮方向一致，绝对 P50 改善>=1ms且超过 A/A 噪声，结果/门
完全等价，才有继续实施的收益依据。这承接首轮明确10%收益门且增加绝对意义约束；
不是对尚未测候选的达标承诺，任何最小试验仍须用户另授权独立方案。

现有 [P0c v4回归门](report-reader-performance-budget.md)另行保留：>5% warning，
同时>10%且>0.1ms才阻断；其25次平均样本P95不是本入口单调用P95。门和收益标准不得混用。
允许结论：局部合成读侧成本排序、未发现值得优化的瓶颈、建议继续测量或提出独立候选。
不允许：生产/HTTP/browser提速、当前证据被重新认证、TD-15整体关闭。

## 验证与交付

专属 fixture/benchmark/真实入口保护测试先通过；受影响 reports/redaction/lifecycle/reader-evidence
与D3旧保护回归、npm run typecheck、lint和文档检查。不改构建/路由/部署，不额外运行本地
build/HTTP/browser；现有 P0c 回归门单独运行，warning照录。coverage不为仅新增离线工具本地扩跑。
按最终 diff 选择 eval-gate，A1不执行本路径，不能预签skip或调用真实模型。

原样本保存在0600私有gitignored evals/out/d3-report-list/，仅版本化合成工具/fixture/test和
脱敏聚合摘要（含原样本hash、源码/依赖/fixture身份）。独立 reviewer 复核完整diff、原样本统计
与结论边界后正常hooks创建Draft PR；精确head/base/tested/run/attempt/CI与产物身份写PR摘要，
新head不沿用#418。至本轮测量与取舍阶段收口，不合并/部署/生产访问/修复或清理worktree。
