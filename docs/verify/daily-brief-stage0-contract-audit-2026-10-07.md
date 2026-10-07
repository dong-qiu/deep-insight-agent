# Daily Brief 阶段 0 证据/发布契约独立审计

> 2026-10-07 · 作者负责契约切片，后续须由非作者复核。实查 base `473e2eeae119b600b63abd78ce886301bd882235`，分支 `docs/daily-brief-stage0-contract-20261007`；仅新增本文及[v0接口候选](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)。不访问生产、不运行模型、不修改schema/agent/来源、不读取原文私有数据；没有认证T03/T04、C1收益、S1或生产功能。

## 实时代码证据与缺口

行号对应上述commit；模块可继续演进，后续合入前须重新核实。规格中的目标不当作代码已经实现。

| 契约项 | 实际位置/已存在行为 | 尚缺/后续依赖 |
|---|---|---|
| 来源配置版本 | [provenance-revisions.ts](../../src/lib/db/provenance-revisions.ts) `sourceConfigSnapshot/sourceConfigRevision`，含逐源transcript policy；[schema.ts](../../src/lib/db/schema.ts) policy registry与更新guard | source family/工作版本映射及v0 evidence revision未见实现；配置revision不证明来源独立性 |
| Content版本 | `provenance-revisions.ts:15-40` 的content-v4 snapshot含URL/source/title/published/fetched/body_kind/fetch_status/body_length/content_hash；[report-review.ts](../../src/lib/db/report-review.ts) `verifyV4ContentSnapshot`验证严格字段/hash | snapshot明确不含正文/raw_ref/speaker map；没有不可变正文版本表；content-v4不能作为全文证据存活证明 |
| 同URL更新 | [schema.ts:923](../../src/lib/db/schema.ts) content_item唯一URL；[collector.ts:267](../../src/lib/agents/collector.ts) 拒绝既存URL形态改变、相同hash跳过，改变正文按原IDupdate并记录persisted ref | 后抓全文/transcript不能覆盖旧show notes；旧节目新增证据版本与revision→archive映射待实现 |
| 原文归档 | [raw-archive.ts](../../src/lib/db/raw-archive.ts) durable raw effect；[reader-evidence.ts](../../src/lib/db/reader-evidence.ts) controlled archive与当前body/hash检查；collector归档envelope | 新版所有形态的immutable revision、章节覆盖/speaker map版本与旧body读回未完整具备 |
| 命题/事件身份 | [report-gen.ts:323](../../src/lib/agents/report-gen.ts) 当前event_id与严格statement fingerprint联合证据deny-list、当前批次单代表；[statement-fingerprint.ts](../../src/lib/runtime/statement-fingerprint.ts) | 稳定完整语义tuple、人工alias版本、重要维度映射与长期published claim集合尚无实现；不能用statement重写或content_item_id变化认命题新增 |
| 原文/断言引用 | [types.ts:139](../../src/lib/types.ts) Citation有claim/quote/locator/主statement绑定；[analysis.ts](../../src/lib/db/analysis.ts) 持久化这些字段 | FactEvidence/AtomicFact/ReportClaim仍为atomic spec目标，无新版 occurrence revision和永久绑定实体 |
| 展示安全 | [analyzer.ts:263](../../src/lib/agents/analyzer.ts) 单citation完整覆盖、bounded span；`auditDisplayCoverage`与quote-only countercheck；[display-coverage-audit.ts](../../src/lib/utils/display-coverage-audit.ts) 显式只接受v6、statement/quote/draft哈希和安全metadata | 不能把多个span自动拼为新可见命题；只中文被降级时不可恢复；新格式member/span与artifact锚映射仍需实现 |
| validator语义 | [validator.ts:57](../../src/lib/agents/validator.ts) reachability/consistency→verdict；`runValidation/summarize/insightInclusion`只明确support可放行；[schema.ts:727](../../src/lib/db/schema.ts) citation_check | 目前check以batch/insight/index为键，缺不可变occurrence+claim+展示+policy逐项绑定；policy重验不能替代旧刊当时依据 |
| 发布白名单 | `report-gen.ts:171-238` audited/source_quote_v1、kept/kept_degraded、主引用/required audit/reader statement hash和pass/support；[reports.ts:71](../../src/lib/db/reports.ts) `assertReportPublicationEvidence`检查精确引用集合与归档 | guard当前JOIN live citation/check/content，不核新版member规范包、lineage与全展示面哈希；必须作为新版子检查保留，不能声称已完成新守卫 |
| 正常/恢复 | [pipeline.ts:440](../../src/lib/agents/pipeline.ts)调用guard；`reports.ts`正常save、`reconcileReportEffects:408`、`reconcileAnchoredReportEffects:506`及[integrity-publication.ts](../../src/lib/db/integrity-publication.ts)已存在intent/effect/stage/anchor提交 | 旧报告可靠性是可复用基础；新格式三个入口同member guard、failclosed整体和legacy兼容仍待生产路径反例 |
| artifact不可变 | `schema.ts:88` artifact_manifest复合version键与append-only触发器；现有anchor/hash/signature/retention材料；[integrity-lifecycle.ts](../../src/lib/db/integrity-lifecycle.ts)删除流程 | artifact字节保护不等于命题/成员图；新member/ledger/lineage必须加入redaction/retention，否则旁路恢复风险未闭合 |
| 发布历史 | `reports.ts:999` `listRecentPublishedInsightOccurrences`按默认14天、done/visible brief+initial_digest，JOIN现行Insight/Citation/Check/Content；内容ID集合保留occurrence | 不是immutable artifact的命题历史，缺semantic claim key与旧刊原展示mode；新版续报与首次判断依赖新ledger而非简单扩查询窗口 |
| 论文来源 | [arxiv.ts:10](../../src/lib/sources/arxiv.ts) `parseArxiv`取Atom `summary`作为body | 不能称论文全文；P HTML/PDF抓取、解析覆盖、作者版本与全文定位待独立来源eval |
| 播客采集 | collector明确生产暂不执行transcript acquisition；[transcript-policy.ts](../../src/lib/transcript-policy.ts)和schema已有off/observe/enabled策略/diagnostic facts | enabled生产写入不是开关即具备；同旧集转写version/命题续报尚缺 |
| 说话人 | types/schema Citation.speaker_attribution、ContentItem.speaker_map；`analysis.ts:38-47`verified必须speaker_id/source_segment及unverified不得携带二者的形状检查；blocked原因枚举已有 | 对base的analyzer/validator检索未找到speaker_attribution/speaker_map/source_segment执行。**形状与枚举不证明unknown人物断言被跨层阻断或map匹配**；C开启前须真实fail-closed与正反例 |
| I工作启示 | [ADR-0043](../develop/decisions.md)确认typed judgment方向；[planning.ts](../../src/lib/db/planning.ts)已有技术机会规划层；TechLead仍来自事实 | 报告公开AnalysisJudgment类型、审核/专用评测/展示/回退未实现；来源明确影响与我们的推论必须分开 |
| F时效 | content_item published_at/fetched_at；现行ReportIndex freshest_*与funnel/provenance事件 | 首次采集、来源可获取、真实事件时间不能从最后fetched补造；历史缺失需unknown与前瞻观察，本文不认证F基线 |

## 可执行交付与完成门

v0现已给出五层稳定键、unknown规则、主证据与展示+validator绑定、artifact/member/claim ledger/lineage、首次新刊/深读更新/分析回访边界、P/C/I/F分层、串行共享模块责任及九组生产路径反例。它是可供下一波消费的文档接口，不在 `src/` 导出类型，不改任何生产开关。

阶段0本文完成门：父Agent整合数据/协议与F字段后冻结接口；非作者逐条复核本表与上述源码；Markdown/本地链接/diff检查、类型检查通过。人工金标/产品阅读门的pending仍由对应协议报告；不能用本作者或其他AI的同意代替。

后续不确定项：source family与真实事件人工映射；关键维度是否会改变结论理解；原子跨度扩展对v6的安全性；新claim历史保留/删除策略；I审核主体与专用门；F各时钟可观测完整率。前三项涉及重要性/事件归属时提交逐项材料给用户，沿用既有签认；不要求用户重新确认已批准的产品方向。

## 验证记录

本轮没有prompt/模型/来源/校验/评测集改动，未运行A1；A1不执行文档接口，不作为该切片或未来功能完成证据。没有eval pass章。下一波任何上述语义改动须按仓库eval-gate，PR前用pre-pr-ai-review，生产部署另备精确版本/验证/回退向用户确认。

- `ops/ci-docs-check.mjs` 的真实 `checkDocuments`：2份文档通过，包含本地链接/标题/围栏/格式及verify章节检查；另逐项路径核对0个断链。
- `git diff --check`通过；仅本作者独占的2个新增Markdown，没有运行无关格式化。
- 使用Node `24.19.0`重新安装锁定依赖后，`npm run typecheck`：TS7/TS6各app/tools均通过。
- 环境修复记录：初始typecheck因新树没有node_modules而MODULE_NOT_FOUND；默认Node25.9首次安装有engine提示，按仓库要求切到24.19重新`npm ci --no-audit --no-fund`，未将环境缺依赖记为代码回归。可选Prettier检查报风格提示；仓库采用上述真实docs门，没有把可选formatter作完成证据。

这里只验证文档契约与现有类型检查。没有新增实现可供单元/生产路径运行；集成负责人另行记录既有204项基线回归，本文不借其认证新版artifact/member功能。非作者审查、整合后精确head CI与T03/T04仍待后续收据。
