# D2 / TD-12：五模块处置与阶段范围收敛

状态：**用户已采纳，本阶段范围收口；原 TD-12 仍为部分完成**。
确认日期：2026-10-06（Asia/Shanghai）。调查日期：2026-10-05（UTC）；本地已进入 10-06。
首次调查基线：`origin/main` @ `92d684bb5dd1428058e07b6c8341b67e3ec074a8`。
采纳更新已同步主干 `5e90ff49a93c269ac801acbc4560b28ccb186e6c`（#415）；保留首次调查快照。
承接 [TD-12 原计划](technical-debt-remediation.md)、[架构](../architecture.md)、
[D2 alert spec](d2-alert-channel-extraction.md) 与 [alert 收据](../../verify/d2-alert-channel-extraction-2026-10-05.md)。
本文只盘点 Analyzer、LLM、reports、report-gen、Controller replay，不实施下一切片。

## 1. 推荐与状态边界

已采纳的本阶段新增必做切片为空。三个模块延期、两个模块保留；不要求五个模块全拆。
理由是可提取边界确实存在，但尚未建立足以优先于正在演进契约的独立需求与收益；
继续搬移会增加共享边界审查、兼容入口与行为基线维护的成本。文件长度不是推荐依据。
这里的“无必做”是已确认的阶段优先级与窗口决定，不是证明全部技术债已消失。

| 跟踪 ID | 模块 / 实际路径 | 已采纳处置 | 证据与主要理由 | 重启门摘要 |
| --- | --- | --- | --- | --- |
| D2-A | Analyzer：`src/lib/agents/analyzer.ts` | 延期 | 输入选段、引用修复、展示审计与分批共存；report-gen 导入其机械 helper；Brief 提取契约及 C4b 恢复身份正在演进 | 明确选段小切片价值；Brief/C4b 接口与源码身份基线交接；冻结合法输入和配置时机 |
| D2-L | LLM：`src/lib/runtime/llm.ts` | 保留 | provider/SSE、usage、budget、cancellation 已分别有模块；callStructured 是统一接线门 | 新 provider/重试规则或第二消费者形成可复现维护困难时重评 |
| D2-R | reports：`src/lib/db/reports.ts` | 延期 | 文件 effect、发布/恢复重验、查询及纯投影混合；C1 删除与 Brief 成员发布都消费此边界 | 明确具体文件交接；投影有独立消费者需求，或发布接口冻结且保护矩阵具备 |
| D2-G | report-gen：`src/lib/agents/report-gen.ts` | 延期 | 选择、账本、渲染、索引/推送映射紧密；Brief 正拟固化成员投影 | Brief 选择/成员/renderer 契约冻结或明确放弃该扩展，真实 runReportGen 等价矩阵补齐 |
| D2-P | replay：`src/lib/controller/replay.ts` | 保留 | 已是固定时钟、零 I/O 的状态机模型；持久化与只读协调在 store/reconciler | 多消费者需要 ready-bundle 独立入口，或 reducer 重复规则/修改故障可复现 |

**阶段范围收口与原 TD-12 全部关闭不是一回事。** #414 只完成 alert 渠道内聚职责。
本文不把保留写成重构完成，不把延期写成问题解决或任务取消，也不修改 roadmap、ADR、architecture、
原技术债计划的完成状态。用户已确认本阶段不再拆分；未来提取设计与实施仍须另行确认和交接。

## 2. 主干事实与既有契约

2026-10-05 fetch origin/main 后，[#414](https://github.com/dong-qiu/deep-insight-agent/pull/414)
显示 MERGED，合并时间 `2026-10-05T15:07:09Z`，mergeCommit 精确等于上述基线。
该提交的 [main push CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330189460)
run `37330189460` / attempt 1 / head `92d684b` 为 success；full application、full Docker、
两个必需汇总与 eval trailer 均 success，documentation checks 按 full 分支 skipped。
[镜像发布](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330921257) success。
仅据 GitHub 元数据核对交付状态；未重新下载 #414 全部产物，不宣称本轮重跑其测试，未访问生产。
合入、CI、镜像发布均不能证明生产已上线，也不能证明其余五模块完成治理。

| 已读取契约 | 本次处置必须保留的边界 |
| --- | --- |
| [D1](d1-database-lifecycle.md) / [交接补记](d1-file-handoff-and-boundary-fixes.md) / [收据](../../verify/d1-database-lifecycle-2026-10-05.md) | 连接、迁移、启动已分离；历史 migration SQL/hash 不改；只读允许引擎 WAL 协调但应用零写；D1 完成不释放 C1/C2b 全目录 |
| [C2a](c2a-task-cancellation.md) | 第一个已观察取消原因、共同 deadline、迟到结果拒绝、租约每写 fencing、既有 drain；远端已发 I/O 不可撤回 |
| [C3](c3-model-usage-persistence.md) | logical call 与真实 transport attempt 分离；unknown/partial 不是零；usage writer 只凭 ownership、不凭业务 cancellation 授权；sticky 写失败拒绝新 transport |
| [C2b](c2b-task-budget.md) | transport 门在 C3 unknown 写之前；只消费 Run 兼容估价，不加 attempt/P1；已派发并发费用按既有收拢契约处理 |
| [分析](insight-analysis.md)、[原子证据方案](atomic-insight-evidence-graph.md)、[严格身份](insight-identity-deduplication.md) | 审计绑定/UTF-16 locator、quote 投影、中文结论哈希、事件严格兜底、全部 occurrence 保留；原子关系图是后续方案，不能当作全部落地 |
| [报告生成](report-generation.md)、[选择质量](daily-brief-selection-quality.md)、[质量复盘](report-quality-review-trace.md) | validator 白名单、真实分支选择账本、正文/索引/复盘原子发布；旧 spec 状态/暂定上限不等于现代码已执行 |
| [provider](volcengine-responses-provider.md)、ADR-0031/0034 | provider 隔离、终态计费后 fail-closed、仅允许的 EOF recovery、schema 门；不重设重试或 thinking |
| [Controller spec](controller-reliability-delivery.md)、[dry-run 边界](../controller-replay-dry-run.md) | 模型 replay、真实本地 CAS、只读注入 ports 与外部集成分层；ready 不是 merge 授权 |
| [C1 恢复契约](recovery-time-coverage.md)、ADR-0041/0042 | 永久本地删除约束不等于可信历史覆盖；合成锚不等于生产恢复许可 |

ADR 来源为只读 [decisions.md](../../develop/decisions.md) 的对应段落，另读取 ADR-0005 的报告级聚合、
ADR-0007 的连续选段、ADR-0009 的 cache 版本、ADR-0029 的复盘发布、ADR-0033 的混合展示、ADR-0038 的当前证据/历史快照分离，
及 [引用一致性契约](citation-validation.md)。
不修改共享文档，也不把旧状态登记覆盖现场事实。

## 3. 活跃工作区与文件窗口

只读执行 `git worktree list --porcelain`，逐工作区 `git status --short` 和
`git diff --name-only origin/main...HEAD`；后者只用于提示分支自有差异，不把分叉较早误判为最新待交付。
没有收到其他 Session 的直接交接回复，Git 干净不表示文件释放；可见工作区也不是所有 Session 的完整登记册。
下表是此次现场快照，不是另一 Session 的承诺。未来实施前必须重新检查。

| 窗口 / 工作区 | 现场证据 | 重叠与交接条件 |
| --- | --- | --- |
| C4b：`insight-agent-c4b` / `perf/c4b-a1-low-risk` @ `bd7519a` | 提交前复查已提交 spec 与 13 个 eval 实现/测试/fixture 文件，仅专属收据未跟踪；其 spec 限 eval，不改 runtime/agents | 无五模块实现文件当前 diff；但源码身份 digest 及 Analyzer chunk/coverage/LLM telemetry 是消费者契约。先冻结 C4b 候选与恢复拒绝规则，再协调源码搬移会导致 checkpoint 拒绝的影响，不为保兼容削弱身份门 |
| Brief：主工作区 `docs/brief-information-density-plan` @ `21414ab` | ADR/roadmap 修改和 4 份未跟踪 Brief 文档 | 共享文档仍由该窗口持有，本轮不改 |
| Brief：`insight-agent-brief-density` / `feat/brief-density-s0` @ `84ada60` | S0 progress 未提交；分支包含成员发布、fast release、rich-insight/freshness、report-generation 及 exporter | 当前 src 未改，不代表未来不冲突；候选生产落点为 analyzer、report-gen、pipeline、reports/report-review/schema。先由 Brief 明确冻结接口、off 路径和成员历史规则再交接 |
| Brief probe：`feat/brief-density-extraction-probe` @ `752cefd` | Git 干净；分支有 exporter 与提取可行性文档 | 保留其范围；诊断收据不是提取已实施证明 |
| C1：`feat/c1-registry-freshness-anchor` @ `8177ff7` | Git 干净；分支涉及 schema、合成 experiments/tests、architecture/ADR | 继续保留 schema/删除/恢复/startup/ops；本轮不推定 reports 发布接口已释放 |
| C1 其他：backup / identity-audit / backup-interval | Git 干净；各分支有 backup/完整性/候选审计文件和专属文档 | 不修改、更新或清理它们；需要改发布/恢复时逐文件而非全目录交接 |
| C2a/C3/C2b、D1 | 最新 main 已含 #406/#410/#412/#411/#413；当前未见其独立 implementation worktree | 已合入不等于自动交接。沿用 D2 首切片的保守占用规则；重开 LLM/Analyzer/pipeline/reports 前确认具体源码和共享测试窗口 |
| D7 / D3 | 本次 worktree 清单未见明确活跃实现窗口 | 仅潜在依赖：ID 长度及报告 query/分页；没有交接证据，不虚构正在占用，触及时另核实 |

只读核对 Brief 工作区 `insight-agent-brief-density` 的三个本地提交文档：
`84ada6041fba753c000fd244c96b910494750a73:docs/plan/specs/daily-brief-density-fast-release.md`、
同 commit 的 `docs/plan/specs/daily-brief-density-member-publication-contract.md` 与
`docs/plan/specs/daily-brief-rich-insight-freshness.md`。
GitHub commit API 当前未找到该本地 commit（422），故不提供尚不可达的远端链接；
本地 `git show <commit>:<path>` 可复核。它们尚非 main 的已生效契约，不把候选方案当作
已经获准生产实现，也不复制到本轮交付。表中只保留与五模块交接相关的摘要。
初查 C4b 为 `64f3656` + dirty eval/spec；提交前复查已前进至
`bd7519ab940e4cc621b37052bb5698d25e9d82ff`，其 spec 已提交，工作树 SHA256 为
`376230b9e9bbe9180aeec3f899827cdcc179bcf35224e0d396e26ff5b988f4a0`；
[可复核 spec](https://github.com/dong-qiu/deep-insight-agent/blob/bd7519ab940e4cc621b37052bb5698d25e9d82ff/docs/plan/specs/c4b-a1-recovery-performance.md)
摘要：仅 eval 的身份/checkpoint/重复读取与合成 runner；模型次数为 0，源码变更可保守拒绝旧恢复。
不复制该工作区文件或私有数据；hash 只是时点身份，非长期全文归档；最新 C4b 提交不表示该窗口已交接。

本轮独占新 `docs/plan/specs/d2-scope-disposition.md` 与专属验证收据。
创建前核实两路径不存在，基于最新主干建立 `docs/d2-scope-disposition` / `insight-agent-d2-scope`。
只复制 gitignored `.env.local`、0600，已有 DB_PATH/DATA_DIR 改成本 worktree 的绝对隔离路径；
未复制 `.data`、SQLite/WAL、原文/报告或 `.env.development.local`，未运行应用或开库。

## 4. D2-A：Analyzer 延期

**职责与调用方。** [analyzer.ts](../../../src/lib/agents/analyzer.ts) 的 `analyze` 经 `chunkByChars`、
`analyzeWithSplit`、`analyzeChunk` 完成输入整形、模型生成、引用修复、展示覆盖/独立复核、语言修复、
ID/审计投影与 chunk checkpoint；`canonicalizeInsightEvents` 用于缓存/新结果合并后的严格对齐。
`pipeline.runAnalysis` 调它，`evals/run-a1.ts` 及 latency/incremental 工具直接消费导出；
report-gen 导入 `coverageGaps/specificClaims`，analysis-cache type-only 引用 HistoricalEvent。
无直接 DB 写入；persisted batch/cache/audit 在 pipeline/db 完成，不能凭名字另造 Analyzer repository。

**具体耦合。** `ANALYZE_BODY_CHARS/SELECT_WINDOW_CHARS/ANALYZE_BATCH_CHARS` 在模块加载时定值
（[L1462](../../../src/lib/agents/analyzer.ts#L1462)、L1618），而 coverage/thinking getter 按调用读取。
`renderItems` 将选段/分隔字节直接交给 `analyzeChunk` user prompt；`analyzeChunkInputSha256` 还绑定完整
输入/历史。移动纯函数若顺带改参数默认或模块加载位置，会改模型输入/cache/checkpoint 身份。
`filterByQuoteCoverage` 持有并发、候选终态与中文再审；错误在 `analyzeWithSplit` 必须区分基础设施、
coverage 拒绝、本地 sticky 控制与内容失败，不能搬移时把预算/coverage 故障变为空新闻。
这是可定位的审查面，不是已复现线上缺陷或已测性能收益。

**保护与缺口。** [analyzer.test.ts](../../../src/lib/agents/analyzer.test.ts) 覆盖完整 verdict 集、
独立 AND gate、自足 quote、UTF-16 唯一坐标修复、绑定、严格事件、topic 全拒绝、chunk 恢复和取消不拆批；
它 mock callStructured，不能证明 SDK 接线。[analyzer-window.test.ts](../../../src/lib/agents/analyzer-window.test.ts)
与原窗口算法比较合法字节；[task-budget.integration.test.ts](../../../src/lib/runtime/task-budget.integration.test.ts)
有真实 Analyzer paid invalid output 不再拆分。[C3 integration](../../../src/lib/runtime/model-usage.integration.test.ts)
另保护 SDK/Job，用于与单元测试互补。当前未有针对拟新叶模块的 facade 引用身份、零 runtime 导入与
完整 renderItems 请求字节前后 fixture；这是提取前要补的保护，不声称原模块无测试。

**可提取边界/收益成本。** 优先候选是连续选段组 `chunkWindows/keywordHits/selectForAnalyze/truncateForAnalyze`
及其常量的兼容入口；机械 quote helper 是另一组，不能一次连带审计与事件编排。
收益是 report/工具可用不加载 LLM/env 的叶入口，当前 runtime import 链支持这一方向；
是否有真实独立消费者/启动痛点及工时、速度收益待确认。成本初估中：需要合法默认值/时机和请求字节保护；
审计/编排成本高，不建议当前进入。持久化适配暂无此模块内职责可提取。

**处置范围与不做。** 延期选段叶模块候选；不改 prompt、筛选/修复/拒绝规则、model、token、ID、
cache/恢复语义、coverage/语言编排，不借拆分启动 Brief 新提取模式。

**重启、窗口与验收。** Brief/C4b 的相关输入、chunk completion 与源码身份接口已冻结或明确交接；
由后续 D2 窗口取得 analyzer.ts、analyzer-window.test.ts、专属新测试归属，pipeline 只有必要接线单独交接。
即使双方仍活跃，只要确认选段是稳定非重叠子集也可申请窄交接，不要求整个 Brief 或 C4b 完成。
固定 topic/items/history/clock/random/config，对原实现冻结请求字节、窗口顺序、异常与 input hash；
原 facade 与叶入口输出相同、输入不变、原加载时机/cache version 不变、叶入口无 LLM/DB/I/O 初始化；
真实 analyze→mock transport 补请求接线，chunk 恢复/覆盖失败/取消/预算回归无退化。

**本项退出。** 本轮盘点退出为“延期 + 已记录条件”，不是完成重构。后续只有交接、小 spec、原实现基线、
独立审查、上述真实路径和质量门通过才可关闭该选段切片；其余 Analyzer 责任另保留。

## 5. D2-L：LLM 保留

**职责与调用方。** [llm.ts](../../../src/lib/runtime/llm.ts) 的 `callStructured → withUsageCall →
callStructuredImpl` 是统一角色/model/provider、结构化接受、重试、费用回调及 telemetry 门。
Analyzer/Validator/reader-language/followup、ppt-polish、A1/canary 工具消费它；无 Job 的调用不自动写用量库。
provider 配置在 llm-provider、Responses SSE 在 volcengine-responses、attempt writer 在 model-usage/db、
任务 budget 在 task-budget，取消工具在 cancellation。多个已有边界支持保留 facade。

**具体耦合与可提取点。** [L536](../../../src/lib/runtime/llm.ts#L536) Responses 与
[L711](../../../src/lib/runtime/llm.ts#L711) Anthropic 各有 schema-safeParse/coerce 和 account 包装，
并非可直接统一的重复：formal terminal 失败需计费、EOF 重试例外、SDK 内部 fetch attempt、
signal、sticky budget/usage 和 telemetry finally 顺序各不同。`coerceStringifiedFields/structuredThinkingConfig`
可成为纯叶函数，telemetry 只读快照/分位数可独立投影；meter 自身有 Map/Set 状态，不能称纯。
拆 provider wrapper 涉编排且已有 SSE adapter，不在当前候选必做范围。

**保护与缺口。** [llm.test.ts](../../../src/lib/runtime/llm.test.ts) 覆盖 coercion、模型分离、timeout/
取消/retry、role telemetry；[llm-provider.test.ts](../../../src/lib/runtime/llm-provider.test.ts) 覆盖默认/
凭据端点隔离；[llm-volcengine.test.ts](../../../src/lib/runtime/llm-volcengine.test.ts) 走 callStructured + fake SSE。
C3 真实 SDK 自定义 fetch 与 C2b hidden retry、并发结算/follower、sticky fault 回归分别在前述 integration 文件。
已有测试不等于所有跨 provider 时序组合都被穷尽；拟拆后的客户端单例/env 时机、统一 schema helper 的
调用次数/副作用等价基线尚无独立冻结包。真实外部协议/模型质量本轮未验证。

**处置、收益风险成本。** 保留现结构与兼容 callStructured API，不拆新统一 provider 框架、不调整
retry/预算/估价/usage/接受规则。纯 coercion 叶模块成本初估低，但没有现有第二生产消费者或故障证明
应优先做；性能/工时收益待确认。编排拆分初估高且 C2/C3 顺序风险已可由代码定位。

**重新评估与验收。** 下次新增 provider、同 helper 出现第二独立消费者、或维护出现可复现时序/重复
修正遗漏时重开 D2-L；后续 D2/runtime 窗口先确认 C2/C3 与 C4b telemetry 交接。若只提纯 helper：
从原实现冻结合法/非法 schema、嵌套字符串、input 不变/原异常与 thinking payload；保持 facade 身份、
模型/env 时机；真实 callStructured/SDK/Responses 及 C2/C3 回归证明 dispatch/费用/usage 顺序不变。
保留验收是记录当前边界、限制和触发门，不新增实现测试。

**本项退出。** 本轮到“有依据保留 + 可重开记录”退出；没有重构完成声明。触发后只关闭所选小职责切片，
不凭一次纯函数提取关闭整个 LLM 治理。

## 6. D2-R：reports 延期

**职责与调用方。** [reports.ts](../../../src/lib/db/reports.ts) 含 `saveReport/saveFailedReport`、
普通/anchored effect 保存与 reconciliation、getReport/FTS/index/query、Brief history/diagnostics，
末尾 `topicEvolution/entityTrends` 是纯报告级聚合。pipeline/scheduler、startup、报告 API/页面、
主题统计/PPT、reader benchmark 消费不同子集。源码没有统一的删除执行器；实际删除/永久约束在
redaction/integrity-lifecycle 及 services，本模块消费该门，不能把删除实现归错。

**具体耦合。** [saveReportWithEffect](../../../src/lib/db/reports.ts#L171) 将 intent 事务、stage/hash/
rename、最后发布事务与 before/assert/after callback 关联；anchored 版本跨 await 后再 guard。
[assertReportPublicationEvidence](../../../src/lib/db/reports.ts#L70) 验每个发布 binding 的
pass/reachability/support/reader eligibility/归档，reconciliation 必须重验，不能只查 quote 可达。
`listRecentPublishedInsightOccurrences` 保留 occurrence，Brief 再 union 历史证据；预先 SQL 折叠会改变
去重语义。C1 永久删除门使历史/FTS/query/发布同时拒绝复活。数据源 raw 缺失与报告历史快照例外
要分别理解。发布持久化、查询可见性及纯投影确实跨职责，安全边界不能按“FS vs SQL”简单切开。

**保护与缺口。** [reports.test.ts](../../../src/lib/db/reports.test.ts) 使用隔离 DB/目录，覆盖双 artifact/
index/FTS、review 绑定、anchor 单份恢复、旧 intent 缺 bindings 拒绝、历史 support 与纯投影真值表；
[reports-cancellation.test.ts](../../../src/lib/db/reports-cancellation.test.ts) 覆盖签名 await 失租约/deadline。
另有 redaction、report-redaction、pipeline-reportgen integration 的真实发布/恢复/删除反例。
未有专门为拟拆适配定义的全部“intent→文件→commit→调用方失联”前后故障矩阵及函数身份基线；
Brief 新成员 manifest 并未实现，现有 tests 不证明未来成员发布安全。不是声称现有恢复毫无保护。

**边界/收益成本与推荐。** 最便宜候选是 `topicEvolution/entityTrends` 与相关类型/稳定排序，
调用方已传 report_index，不需 DB；收益为纯聚合入口不载入 FS/发布依赖。
当前无第二使用场景、测试初始化痛点或性能测量证明它为必做，独立投影可保留至触发。
其测试在 reports.test.ts 的 openDb fixture 下，若分离应验证叶模块零 DB import，而不是保留 DB 套件冒称纯隔离。
发布 effect 适配有价值但需 C1/Brief 共同界定 callback/事务/恢复接口；初估高。
纯投影初估低，查询分组中；均是定性相对成本，未估工时或承诺性能。
模块整体推荐延期，并未因 C1 阻塞纯投影技术可行性。

**范围、不做、交接与重启。** 后续 D2-R 先只考虑报告级纯投影，另切片才考虑持久化；不改 SQL/
索引/分页、删除/hold、schema/migration、anchor、历史数据或恢复准入。负责窗口为后续 D2/db：
reports.ts + 相关测试逐文件交接；若只搬纯投影，C1/Brief 可以批准稳定尾部窄交接，不能强制等待全任务结束。
发布适配须先冻结 C1 红线与 Brief 新成员 callback/guard 决策，不要求 C1 生产历史恢复完成。
D3 query 或 D7 ID 范围确实触及时才协调。

**可执行验收。** 投影：固定同日/不同日顺序、空 tags/entities、空白/重复实体、限额/桶/趋势结果，
原输入不变，原 exports 兼容，叶模块零 fs/DB/env/clock；真实主题消费者结果相同。
发布适配若另获准：合成真实 DB/FS、原 intent/manifest/hash/status/SQL 事务次序/幂等键不变；
中断、缺文件/hash、删除竞争、原文缺失、无 review/binding、signer await 取消/失租约、
普通/anchored recovery 均 fail closed；getReport/index/FTS/历史同可见性，不恢复旧引用。
旧 migrations/hash 零变更；不能以纯投影测试证明发布 adapter。

**本项退出。** 本轮退出为延期记录完备。后续纯投影切片通过只关闭该投影；发布/恢复部分独立追踪，
不将任一小切片写成 TD-12 全关闭。

## 7. D2-G：report-gen 延期

**职责与调用方。** [report-gen.ts](../../../src/lib/agents/report-gen.ts) 是确定性选择、
`persistedSelectionDecisions/summarizeBriefSelection`、`buildReport`、Markdown/HTML、index 与
`reportHighlights` 映射；不调用模型也不写库。真实编排 `runReportGen` 在
[pipeline.ts](../../../src/lib/agents/pipeline.ts#L342)，从 DB 历史与 lookup 经 selection→build→save
再发通知；tech-leads、PPT、A1 也消费 selectInsights/身份键。不能按文件名把整个报告 Job 编排搬进它。

**具体耦合。** `selectReaderEligibleInsights` 同时校验 v6 audit/hash/绑定主引用与 validator 白名单；
`summarizeBriefSelection` 必须先新鲜度/历史，再代表项，否则唯一新鲜低排名 occurrence 会被过早丢弃。
该单次返回的 included/summary/decisions 是一组发布事实，`buildReport`/`reportHighlights` 用同一 included。
report-gen 的 mechanical 引用 helper runtime import Analyzer，纯渲染入口仍加载模型/env；
`buildReport` 缺省 UUID/Date，不能无条件声称纯函数；渲染在固定 id/now/lookup/included 时才可等价比较。
Brief 候选方案拟引入不可变成员包、共同正常/恢复 guard 和固化投影，当前拆选择/渲染会遇上接口重做。

**保护与缺口。** [report-gen.test.ts](../../../src/lib/agents/report-gen.test.ts) 保护 audit/validator/
blocked/flagged/缺 check、freshness/history/representative、决策、中文绑定/quote fallback、编号/HTML scheme/
转义、deep_dive 和 push/index 共用要点。
[pipeline-reportgen.integration.test.ts](../../../src/lib/agents/pipeline-reportgen.integration.test.ts)
虽顶层 mock buildReport，但 deleted history、unrendered secondary、Chinese conclusion、duplicate winner
等用 `vi.importActual(...).buildReport`，真实生成/保存/reader；“publishes a validated report”用
mockReturnValue，仅证明持久化，不能统称所有用例都执行真实 renderer。
缺口是拟拆前冻结完整 md/html/index/notify payload 同一次 selection 的跨入口对照，及新成员格式
真实路径的故障/历史/off-on-off 矩阵；不是否定已有集成测试。

**边界与收益风险成本。** 可按“完整选择结果 + 账本”或“固定投影的渲染组”各做一个内聚切片；
不能同时提取 selection/render/通知/Job。持久化适配在 reports，编排在 pipeline，是后续独立归属。
潜在收益为隔离规则测试与减少再次选择的漂移；当前 runReportGen 已复用 included，
所以不宣称已存在重复选择 bug 或拆分能提高日报质量。Leaf 去 Analyzer 依赖可能有收益，但需先冻结
mechanical helper 字节并确认它与 D2-A 的责任窗口。成本初估中到高，工时/性能收益待确认。

**范围、负责窗口与重启。** 延期选择/渲染结构重组；不改白名单/审计、历史/新鲜度、补充发现上限、
文案/排序/引用编号、ID、Story schema/迁移、prompt 或通知渠道。Brief 冻结候选新格式接口、off
兼容与成员历史，或明确不推进该扩展后，由后续 D2/report 与 Brief 串行交接 report-gen.ts、
report-gen.test.ts、pipeline-reportgen.integration.test.ts。pipeline.ts 不属于本文件切片的默认授权，
必要接线另申请；D7 ID 实际进入时才协调，C4b selectInsights 消费也需确认源码身份影响。
接口稳定的窄渲染组获明确交接时可先做，不以全 Brief 完成为必需。

**可执行验收。** 从原实现在固定 id/now/locale/lookup/batch/validation/asOf/history 下冻结
selection/decisions/order、完整 md/html、index、notify payload；正常、空刊、blocked/flagged/缺审计/
哈希错、legacy duplicate、唯一 fresh loser、supplemental limit、zh/quote fallback 都逐字段等价。
原 API 兼容；真实 runReportGen 调真实 selector/build/renderer/save/reader，只 mock 模型/通知 transport；
通知只在发布成功后，index/notify 引用同 selection，失败无成功通知。
existing migration/取消/fencing/预算/review/删除与两个 recovery 路径不退化；新成员测试由 Brief
负责，不能拿旧模式等价提前认证新模式。

**本项退出。** 本轮为有条件延期；后续获准的一组职责达到固定输入与生产接线门才关闭该切片。
延期不是取消日报治理，本文也不决定 Brief 的上线范围。

## 8. D2-P：Controller replay 保留

**路径核实。** 候选确为 [src/lib/controller/replay.ts](../../../src/lib/controller/replay.ts)，
不是 `ops/replay-redaction-registry.ts`、恢复登记工具或 A1 checkpoint replay。前者模型 replay
不访问应用 DB/生产；后者属于 C1，不在五模块清单内。

**职责与调用方。** `replay/replayJsonl/createControllerRecord` 以固定 fixture clock 处理 generation、
lease fence/heartbeat、freshness/TTL、transition envelope、audit 与 notification plan。
`readyBundleFor/readyBundleHash/normalizeFreshness` 被 reconciler/store/ports 消费。
文件无 imports/外部 I/O；reducer 内对 record 原地变更，但该 record 从 fixture 拷贝创建，不能把
每个内部 helper 都描述为无副作用。[store](../../../src/lib/controller/store.ts) 管真实本地 CAS/SQLite，
[reconciler](../../../src/lib/controller/reconciler.ts) 管注入的只读 snapshots；边界已经成立。

**具体耦合。** `readyBundleEvidence/createReadyBundle/readyBundleVerifiable` 与 active evidence、
TTL、generation/freshness、receipt refs、字段 JSON 顺序/FNV hash 互锁；store 检 bundle，reconciler 建 bundle，
reducer 则生成转换与审计顺序。只抽 hash 或 bundle 可能形成类型/freshness 回环，输出 hash 变动会触及
持久记录验真。此风险可定位，但没有证据表明现代码已产生失配或必须拆分。

**保护与缺口。** [replay.test.ts](../../../src/lib/controller/replay.test.ts) 与 fixtures 覆盖 stale/
重复 generation、90s heartbeat、expired evidence、recovered bundle tamper、human boundary、
repair exhaustion/通知 plan dedupe；[store.test.ts](../../../src/lib/controller/store.test.ts) 覆盖真实
双连接 CAS、restart/pending fence、outbox claim；[reconciler.test.ts](../../../src/lib/controller/reconciler.test.ts)
覆盖只读 port、新鲜度重验/缺 proof 与无 mutation capability。
这些分别证明模型/本地存储/注入协调，不能证明真实 GitHub/Multica、外部投递或平台租约。
若未来提取，须再从原 replay 冻结全部 JSONL 的完整 record/state_sequence/audit_hash/notification
与输入不变，不以测试只断言最终状态代替完整序列等价。

**处置与收益成本。** 保留 pure-model/store/read-only orchestration 现边界，不拆 adapter 或连接
外部服务。候选 ready-bundle/freshness 叶模块能降低 reducer 阅读负担，但独立需求、故障与性能收益
均待确认；成本初估中（类型/哈希/序列/存储消费者），无当前文件占用证据，仍需 Controller 窗口确认。

**重开与验收。** 第二个实际 bundle 消费者需要不载入 reducer 的入口，或发生可复现 TTL/freshness
规则重复修改遗漏时重评；真实外部 adapter 另属功能准入，不由拆分授权。
后续 D2/Controller 窗口取得 replay.ts/专属 fixture 与测试交接，store/reconciler 如需改入口另交接。
固定 fixture clock/order/JSON 编码，原 exports 兼容，完整输出及 hash 同字节，leaf 不引 store/DB/
network/clock；真实 store round-trip、CAS/pending fence 与只读 reconciler 回归不变。

**本项退出。** 本轮退出为有依据保留、风险/重启门记录完备；不是重构或外部集成完成。

## 9. 已采纳的阶段退出方案与后续追踪

本阶段必做切片及顺序：**空**。停止扩展理由是已有 alert 小切片完成，剩余三模块的稳定
价值/契约窗口不足，另两模块已有合理边界；无证据支持立即启动广泛搬移。不是等待生产或付费
模型才能做文档范围判断；也不是五模块经 #414 回归已认证。

当前保留风险分别是 Analyzer 的机械 helper 依赖与审计/配置时机、LLM 的 provider 时序/全局 meter、
reports 的 FS/SQL 发布和恢复重验、report-gen 的统一选择投影、replay 的 bundle/hash/TTL。
不承诺风险为零、性能提高或省多少工时。跟踪用本文 D2-A/L/R/G/P，不创建会暗示实施授权的新任务。
窗口交接、第二消费者、复现维护故障或相关契约变更发生时，重开对应项，不自动重开全部 TD-12。
负责角色是后续 D2 协调窗口及表中模块窗口，当前没有指定个人接手或实施日期；具体负责人/时点待交接确认。

若用户以后选择实施，顺序规则仍为：原实现冻结保护 → 单模块的一组纯职责 → 另切片持久化适配 →
最后编排；这不是当前推荐执行队列。D2-A 机械 helper 与 D2-G 共享依赖必须串行；reports 发布与
Brief/C1 串行；投影、LLM 纯 coercion、Controller bundle 只有文件/测试及共享入口都不重叠且明确
交接后才可并行。main 前进后重核基线，不把首次调查 hash 当永久事实。

未来验收共同门：固定输入逐字段/字节等价、旧 facade/类型入口兼容、真实调用方路径测试、相关
回归 + `npm run typecheck`，影响构建/路由才 build；涉及 Analyzer/LLM/report-gen 等命中
[eval-gate](../../../.agents/skills/eval-gate/SKILL.md) 必须由最终 diff 选择证据。
不预盖 skip；正常 AI 输入/接受或判断语义变动需停止等价拆分、单独确认与真实模型授权。
确定性 report selection/render/索引/通知按生产路径回归，不以不执行这些代码的完整 A1 代证。
任何共享文件、模型请求、生产操作均不因本文自动获准。

本 Session 退出验收：五项证据/处置/范围/验收/窗口/退出与重启条件齐备，独立 reviewer 已检查，
重要分歧修正复查，专属文档链接/格式/diff 检查通过；文档 PR/CI 仅证明文档交付。
测试盘点为静态阅读，本轮不运行应用测试/模型/A1，不修改 src/tests/schema/迁移/依赖/CI。
独立评审与实际检查见 [本轮收据](../../verify/d2-scope-disposition-2026-10-05.md)。

## 10. 用户确认与授权边界

采纳更新时 [C4b #415](https://github.com/dong-qiu/deep-insight-agent/pull/415) 已于
`2026-10-05T16:01:30Z` 合入 `5e90ff49a93c269ac801acbc4560b28ccb186e6c`。
对照 [C4b 已合入契约](c4b-a1-recovery-performance.md) 与
[收据](../../verify/c4b-a1-recovery-performance-2026-10-05.md)：改动限 eval 与专属文档，
未改五模块实现；源码身份绑定仍刻意保守，合入不自动释放后续文件/接口交接，也不授权恢复或付费重跑。
第 3 节保留首次 Session 快照；C4b 已合入不改变五项处置或重启条件，不以其测试代证五模块治理。

用户于 2026-10-06（Asia/Shanghai）回复“确认采纳”，已确认以下范围决定：

1. 本阶段无新增必做切片，alert 后停止扩展，本阶段范围收口。
2. Analyzer/reports/report-gen 延期，LLM/replay 保留；保留五个跟踪 ID、风险、交接与重启条件。
3. 原 TD-12 继续部分完成；整体关闭须另有明确范围决定，保留不等于重构完成，延期不等于解决或取消。

这次确认仅采纳上述范围决定，不包含文档 PR 合入、后续切片实施或整体关闭授权。
本轮仅更新专属文档与 PR，不修改共享 roadmap/ADR/architecture 或原计划完成状态，不合并、
不启动后续拆分，不访问生产、调用付费模型、部署、恢复、历史修复或清理任何分支/worktree。
