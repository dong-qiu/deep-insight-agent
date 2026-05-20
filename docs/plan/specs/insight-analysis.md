# Spec: 洞察分析 (Insight Analysis)

> M1 计划阶段产物 · MVP 范围 · 状态：🟠 评审中 · 2026-05-20

## 背景与目标

MVP 端到端管线的核心段。把采集到的多源内容提炼成围绕主题的结构化洞察。
对应核心能力「洞察」。本 spec 承载关键假设 **A1**（LLM 能否可靠提炼非显然、可溯源、
低幻觉的洞察）—— A1 验证为 DCP-1 硬门槛（见 AC10）。

MVP 范围：主题聚合 + 趋势识别 + 信号去噪 + 多源交叉；**不含**趋势预测、实体追踪、
最佳实践归纳（`Insight.type` 仅 `aggregation` / `trend`，其余后续迭代）。

## 用户故事

- As a 用户, I want 系统把多源内容按主题聚合并标出重要信号, so that 我能快速看到一个领域在发生什么。
- As a 用户, I want 每条洞察都带可溯源引用, so that 我能信任并核实它。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `ContentItem[]`（按 `topic_ids` 命中 + 时间窗切片）；`Topic`；**历史 `event_id` 池**（该 `topic_id` 历史批次的 `event_id` 列表，用于跨批次对齐复用）；字段见 `architecture.md`「数据模型」 |
| 输出 | `AnalysisBatch`（字段见 `architecture.md`「数据模型」）—— 含 `insights: Insight[]`、`status`、`no_significant_event`；无重要事件时 `insights` 空、`no_significant_event=true`、`status=done`；批次失败时 `status=failed`、`no_significant_event=false`、`insights=[]` |
| 触发 | 定时（每日 / 周）/ 按主题手动 / 按事件 / 被 `report-generation` 同步触发（深挖） |

## 行为规约

1. 主题聚合：跨源、跨语言整合同主题信息，归并近义说法。MVP 仅整合不翻译，输出语言跟随 `Topic.language`。
2. 趋势识别：基于时间维度的热度变化、新兴主题、关联事件聚合；**仅描述已发生的变化，不输出方向性预测**。数据量不足时产出 `type=trend` + `confidence=low` 且 `statement` 标注「积累中」，不编造趋势。
3. 关联事件聚合：把指向同一现实事件的洞察赋同一 `event_id`。赋值时与「历史 `event_id` 池」比对 —— **判定准则**：① 该洞察 citations 与某历史 event 的 citations 有共享 `content_item_id`，或 ② `statement` 语义高度相似（LLM 评判）→ 复用既有 `event_id`；否则分配新 ID。这是下游「不复报 / 同事件更新」的前提。
4. `Insight` 必填字段赋值规则：`time_window` 继承 `AnalysisBatch.time_window`；`language` 取 `Topic.language`（`Topic.language=mixed` 时取该洞察 `citations` 引用内容的主语言）；`source_count` = 该洞察 `citations` 经 `Citation.content_item_id` → `ContentItem.source_id` **去重后的源数**；`multi_source` = `source_count ≥ 2`。
5. 信号去噪：按重要性评分 + 阈值过滤（阈值见 `eval-criteria.md`，默认 = 3）；评分须写入 `importance_basis`。**过滤发生在生成 `Insight` 前**，`AnalysisBatch.insights` 中不出现 `importance < 阈值` 的条目。某窗口无重要事件时输出 `no_significant_event=true` + 空 `insights`，不凑数。
6. 多源交叉：`source_count ≥ 2` 置 `multi_source=true`；单源结论允许输出但 `multi_source=false` 明确标注（重要结论 `importance ≥ 4` 优先选多源印证）。
7. 每条洞察必须挂 ≥1 条 `Citation`（含 `quote` + `locator`），无引用不输出。
8. 中性叙述：不做趋势预测、不主观臆断、不带情绪。
9. 一致性：用低温 + 结构化输出约束、提供商支持时加固定 seed，使输出可复现（目标为 AC6 的统计稳定，非逐字节复现）。
10. 容错：LLM 调用失败 / 超时 / 返回非法结构时按上限重试（默认 3 次）；仍失败则 `AnalysisBatch.status=failed`、`no_significant_event=false`、`insights=[]`，通过管理看板告警通道告警（与 `data-collection` 同一通道），不产出半成品。
11. 分析用 LLM 可配置（提供商 / 模型 / 参数），不同子任务可分别指定；事件对齐子任务的 LLM 可独立配置。

## 验收标准 (AC)

- [ ] AC1: 给定 `Topic` + 一批 `ContentItem` + 历史 `event_id` 池，输出 `AnalysisBatch`，其 `insights` 每条含 schema 全部必填字段（含正确的 `time_window` / `language` / `source_count`）。
- [ ] AC2: 100% 的 `Insight` 含 ≥1 条 `Citation`；无引用的结论不出现在输出。
- [ ] AC3: 趋势识别能从带时间跨度的输入识别热度变化 / 新兴主题；数据量不足时产出 `confidence=low` + 「积累中」标注而非编造趋势。
- [ ] AC4: 输出的 `insights` 中**不存在 `importance < 3` 的条目**（过滤发生在生成前）；无重要事件时 `no_significant_event=true` 且 `insights` 为空；每条 `Insight` 的 `importance_basis` 非空。
- [ ] AC5: 多源印证结论 `multi_source=true`、单源 `false`；近义说法被归并（同义信号不重复成多条洞察）。
- [ ] AC6: 同一输入连续运行 N 次，重要性 Top-K 集合重合度 ≥ X%、引用的 `content_item_id` 集合稳定（N / K / X 见 `eval-criteria.md`）。
- [ ] AC7: 输出 100% 符合 `architecture.md`「数据模型」的 `AnalysisBatch` / `Insight` schema。
- [ ] **AC8（event_id 跨批次对齐）**: 在 `eval-criteria.md` 规定的「事件对齐集」上，event_id 对齐准确率 ≥ 阈值（同一现实事件在相邻时间窗批次中被赋相同 `event_id`，新事件分配新 ID）。
- [ ] AC9: 注入持续失败的 LLM 调用，重试耗尽后 `AnalysisBatch.status=failed`、`no_significant_event=false`、`insights=[]`，并通过管理看板告警通道告警。
- [ ] **AC10（A1 验证 · DCP-1 硬门槛）**: 在 `eval-criteria.md` 规定的真实数据评测集上，引用一致性合格率、非显然洞察占比、幻觉率达到 `eval-criteria.md` 上线门槛。

## 非功能要求

- 性能：本段时延预算 ≤ 6 分钟（端到端「主题深挖」P50 ≤ 10 分钟的份额；校验 ≤ 2.5 / 报告 ≤ 1.5）。
- 成本：单次分析 token 成本可估、可控（A5）；成本口径见 `eval-criteria.md`。
- 可观测性：每次分析的输入切片、prompt / response、耗时、成本可在看板下钻；失败批次通过管理看板告警通道告警。

## 依赖与影响范围

- 依赖：`data-collection` 的 `ContentItem`；历史 `event_id` 池（由本 spec 归档实现提供）；数据模型见 `architecture.md`；prompt 模板见 `skills/L1-domain.md`；评分阈值与评测集见 `eval-criteria.md`。
- 影响：`src/lib/agents/analyzer.ts`、`src/app/api/analyze/`。
- 下游：`citation-validation` 校验引用；`report-generation` 消费洞察。

## 开放问题

- 重要性评分 1–5 各档的细则（阈值已定 = 3；评分细则随 prompt 在 develop 阶段定）。
- 跨语言翻译是否进 MVP；当前规约取「仅整合不翻译」。
- 「数据量不足」触发冷启动趋势 `confidence=low` 的具体门槛（M1 末标定）。
