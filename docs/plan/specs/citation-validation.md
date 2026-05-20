# Spec: 引用校验 (Citation Validation)

> M1 计划阶段产物 · MVP 范围 · 状态：🟠 评审中 · 2026-05-20

## 背景与目标

「可溯源」是产品的核心差异化与质量底线。引用校验分两层 —— **可达性** 与 **一致性**
（见 `product-definition.md`「质量原则」「报告 · 可溯源」）。其中一致性校验
（"可点回原文" ≠ "原文支持该结论"）是质量重点投入项。本 spec 定义 MVP 的引用校验能力。

## 用户故事

- As a 用户, I want 报告里每条引用都真实存在且确实支持对应结论, so that 我不会被"看似可溯源、实则曲解原文"误导。
- As a 管理员, I want 看到一致性失败率与 flagged 率的趋势, so that 能及时发现质量退步。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `AnalysisBatch`（其 `insights` 的 `Citation` 提供 `quote` 与原文 `locator`）；经 `Citation.content_item_id` → `ContentItem.raw_ref` 反查的原文 |
| 输出 | `ValidationResult`（字段见 `architecture.md`「数据模型」）—— 逐引用 `CitationCheck`（可达性 / 一致性 / `consistency_reason` 枚举 + `verdict`）+ 整体 `ValidationReport`（含 `consistency_failure_rate`、`flagged_rate`、`releasable`） |
| 触发 | 洞察生成后、报告定稿前自动触发 |

## 行为规约

1. 可达性校验（自动）：`ContentItem` 来源真实存在、可访问；`Citation.quote` 确实出现在经 `raw_ref` 取回的原文中（按 `locator` 定位核对）。
2. 一致性校验：判断 `quote` 所在原文是否真正支持 `Insight.statement`（无断章取义 / 夸大 / 张冠李戴）。MVP 采用 LLM-as-judge；低置信度判定归为 `uncertain` 并入人工抽检队列。
3. 校验模型须**独立于** `insight-analysis` 的生成模型（提供商或模型不同，建议更强推理），降低同源偏差。
4. 判定与处置严格按 `architecture.md`「数据模型 · 校验结果 · 校验判定流程」：可达性先行，落 `fail` 则短路（`consistency=not_evaluated`、`consistency_reason=not_evaluated`）；可达性 `pass` 再做一致性；最后由全函数 verdict 表定 `verdict`。`consistency_reason` 取值严格按其取值约束（见 architecture.md）。
5. 误判倾向：一致性不确定时偏保守（判 `uncertain` / `not_support`），宁误杀勿漏网，呼应「幻觉零容忍」。
6. 安全：喂给校验模型的原文片段按不可信内容处理（来源隔离 / 指令剥离），防 prompt injection 污染校验结论。
7. 人工抽检：按 `eval-criteria.md` 规定比例抽检校验结果，作为护栏指标真值来源；抽检发现的错误回流校准 LLM-judge 判定阈值（自动 `consistency_failure_rate` 是代理指标，人工抽检的「幻觉率」是真值）。
8. 容错：网络类失败（超时 / 限流）置 `retryable` 重试（默认上限 3 次），区别于内容类 `fail`。
9. `releasable` 计算：「有效洞察」= 经「洞察级纳入判定」剩余引用 ≥ 1 的洞察。剔除全部 `blocked` 后仍有 ≥ 1 条有效洞察 → `releasable=true`；`total=0`（空批次 / 上游 `no_significant_event=true`）→ `releasable=true`（让 brief 走「无重要事件」路径，**不置 failed**）；其余 → `releasable=false`，下游报告置 `failed`。
10. 上报两个护栏指标：`consistency_failure_rate`（= `not_support` 占比，引用级）与 `flagged_rate`（= `uncertain` 占比，引用级），见 `charter.md` 成功指标与 `eval-criteria.md` 阈值。

## 验收标准 (AC)

- [ ] AC1: 引用指向不存在 / 不可访问来源时，`reachability=fail`、`reachability_reason` 取值正确，短路使 `consistency=not_evaluated`、`consistency_reason=not_evaluated`、`verdict=blocked`。
- [ ] AC2: `quote` 不在原文时，`reachability=fail`、`reachability_reason=quote_not_in_source`。
- [ ] AC3: 在 `eval-criteria.md`「引用一致性集」上，三分类（support / not_support / uncertain）判定准确率 ≥ 90%、对负例（not_support）召回率 ≥ 95%。
- [ ] AC4: 网络类失败判 `retryable` 并重试，与内容类 `fail` 区分；重试耗尽才归为 `fail`。
- [ ] AC5: `verdict` 严格按校验判定流程取值；`consistency_reason` 严格按取值约束；`blocked` 内容不出现在最终报告，`flagged` 内容带「待核实」标记。
- [ ] AC6: `ValidationReport.consistency_failure_rate` 与 `flagged_rate` 计算正确，且在评测集上均达 `eval-criteria.md` 上线门槛（≤ 5% / ≤ 10%）；管理看板可查看趋势。
- [ ] AC7: 校验模型配置与分析模型配置不同（提供商或模型 ID 不同），配置层强制可校验。
- [ ] AC8: 空批次（`total=0` 或上游 `no_significant_event=true`）时 `releasable=true`，下游报告**不置 failed**，brief 走「无重要事件」路径。

## 非功能要求

- 性能：本段时延预算 ≤ 2.5 分钟（端到端「主题深挖」P50 ≤ 10 分钟的份额）。
- 成本：一致性校验耗模型 token，单条引用成本可估（口径见 `eval-criteria.md`）。
- 可观测性：每条引用的可达性 / 一致性结论、失败原因枚举、`verdict` 可下钻；两个护栏率趋势上看板。

## 依赖与影响范围

- 依赖：`insight-analysis` 的 `AnalysisBatch`（含 `Citation`）；`data-collection` 经 `raw_ref` 归档的原文；数据模型见 `architecture.md`；判定方法 / 阈值 / 抽检比例见 `eval-criteria.md`。
- 影响：`src/lib/agents/validator.ts`、看板指标上报、与 `report-generation` 的集成点。
- 下游:`report-generation` 按 `verdict` 与「洞察级纳入判定」纳入内容。

## 开放问题

- 一致性校验从 LLM-as-judge 起步；是否引入专用 NLI 模型按 MVP 后效果评估。
- 旧报告原文被归档清理后如何重新校验（MVP 不清理；归档策略变更时再议）。
- 洞察级「待核实」比例是否独立上看板（引用级 `flagged_rate` 已上报，洞察级可留作 MVP 后能力）。
