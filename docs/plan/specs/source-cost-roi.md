# Spec: 按源成本 / ROI（ADR-0008 决定⑦ / 切片4）

> 设计文档（实施前对齐）。落 ADR-0008 决定⑦：LLM 洞察系统源管理的第一性约束是**每源分析花费**。
> 第二轮评审纠正：归因「数据已落库」是**夸大**——分子勉强可拉、**分母无现成数据须建模**。本文先定归因口径。

## 背景与目标

源管理只谈「可达性/健康/抓取」漏了最贵一维：**每源每轮占用 analyzer 预算多少、换回多少被采纳的洞察**。体检里低产出源（`owasp_llm` 3 条、`github_eng` 10、`mitre_atlas` 12）每轮仍吃分析预算，ROI 存疑。目标：算**每源 cost-per-adopted-insight**，产出按源 ROI 看板 + 低 ROI 告警，**供人工决策**（不自动按成本停源——成本低≠不重要，如 OWASP 权威但稀疏）。

## 用户故事

- As 运维, 我想看**每源摊到的分析成本 vs 它贡献的被采纳洞察数**，判断低 ROI 源值不值得继续每轮花钱。
- As 运维, 低 ROI 源**告警**提示我复核（人工决定停/留），而非自动摘除。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | analyze `run.cost`（per `{topic_id}` 批记，**无 source 维度**）；`citation.content_item_id → content_item.source_id`（被引洞察→源）；`report` 的 insight_ids（已上报洞察）；**新增**：analyze 时每 batch 的「按源 item 数」（当前未持久化，须捕获——见命门） |
| 输出 | 按源 ROI 表：`{source_id, 摊到分析成本, 贡献被采纳洞察数, cost_per_adopted_insight, 时间窗}`；低 ROI 告警 |
| 触发 | 看板查询（读时聚合）或定期归因 job；**不喂决定②软熔断**（health 与 ROI 正交，评审🔴） |

## 命门：归因链现状（评审核实，须诚实建模）

### 分子（被采纳洞察 → 源）：可拉，口径有限

- 路径：`report.insight_ids → insight → citation.content_item_id → content_item.source_id`。即「上报的洞察引了哪些 item、item 属哪些源」。
- 限制：① 只覆盖**被引用**的洞察（未引洞察无源）；② 一条洞察常 multi-source（多 citation 跨源）→ 该洞察的「贡献」要**按源均摊或计数**（口径需定，见开放问题）。
- `insight`/`analysis_batch` 表**本身无 source 维度**（`schema.ts`：insight 只有 `source_count`/`multi_source` 计数、batch 只有 `topic_id`）——「insight→batch→source」这条路**不存在**，只能走 citation。

### 分母（每源分析成本）：**无现成数据，且 batch→item 映射根本没持久化**

- analyze `run.cost` 是 per `{topic_id}`（`pipeline.ts:25`，一个 batch 跨多源），**无法拆到源**。
- 更糟：**喂给 analyze 的 content_item 清单（batch 的输入）当前根本没持久化**——只有事后 citation 链反推「被引的 item」，但「被引 ≠ 被喂」（喂了 20 条、引了 5 条，另 15 条也占了 analyze 的 token 成本）。
- 故分母要**新增数据捕获**：analyze 时记录该 batch「**按源 item 数 / 按源喂入字符数**」，成本按占比摊派。这是**建模任务、不是取数**。

## 行为规约

### 1. 新增 batch 输入归因捕获（分母地基）

- analyze 选完喂入清单后（`analyzer.ts` selectForAnalyze 之后），落一张 **`batch_source_input`**：`{batch_id, source_id, item_count, char_count}`（每 batch × 每源一行）。
- 摊派口径：该 batch 的 analyze `run.cost` × `(源的 char_count / batch 总 char_count)` = 该源在该 batch 的摊派成本（按字符占比，比按条数更贴 token 成本）。

### 2. 分子归因

- 对每份已上报 `report`：其 insight_ids → 每条 insight 的 citations → distinct source_id 集 → 每源「贡献被采纳洞察」+1（multi-source 洞察对每个被引源各 +1，或按 1/n 均摊——口径见开放问题）。

### 3. ROI 聚合与告警

- 按源、按时间窗聚合：`摊派分析成本合计` / `贡献被采纳洞察数` = cost-per-adopted-insight。
- 看板：源健康表加 ROI 列（成本、被采纳数、单位成本），高成本低产出排前。
- 告警：`cost_per_adopted_insight > 阈值` 或「窗口内摊派成本 > X 且 被采纳=0」→ 按源低 ROI 告警（**人工决策**，不自动停）。

## 验收标准 (AC)

- [ ] AC1: analyze 后 `batch_source_input` 正确记录每 batch 各源 item/char 数。
- [ ] AC2: 某源摊派成本 = Σ(各 batch 成本 × 该源 char 占比)，跨 batch 累加正确。
- [ ] AC3: 被采纳洞察归因：multi-source 洞察按定好的口径（均摊/计数）归到各被引源。
- [ ] AC4: ROI 表按「高成本低产出」排序；低 ROI 触发**告警但不改 enabled**。
- [ ] AC5: ROI **绝不**作为决定②软熔断输入（health/ROI 解耦，可单测验证调用隔离）。

## 非功能要求

- 性能：归因为读时聚合或离线 job，不拖慢管线；`batch_source_input` 写入在 analyze 落库时一并做。
- 成本：归因本身零 LLM。
- 可观测性：ROI 进 admin 看板 + 低 ROI 告警。

## 依赖与影响范围

- **schema**：新表 `batch_source_input(batch_id, source_id, item_count, char_count)`（`CREATE IF NOT EXISTS`，新表无迁移风险）。
- **改**：`agents/analyzer.ts`/`agents/pipeline.ts`（analyze 落 batch_source_input + 该 batch 的 run.cost 关联）、`runtime/run-stats.ts` 或新 `source-roi.ts`（聚合 ROI）、admin 看板（ROI 列）、`runtime/alert.ts`（低 ROI 告警）。
- **依赖**：技术上**不依赖切片②③**（citation 链 + 新捕获表独立）；可并行实施。
- **历史数据**：`batch_source_input` 只能从**实施后**的 batch 起有数据（旧 batch 无输入清单可回溯）——ROI 看板前期数据稀、随新批次积累；不回填（同 ADR「派生即正确」取向）。

## 开放问题（实施前需拍板）

1. **multi-source 洞察的分子口径**：一条洞察被 3 个源佐证 → 每源各 +1（计数，鼓励多源佐证）还是各 +1/3（均摊，总量守恒）？影响 ROI 可比性。
2. **分母摊派口径**：按喂入 char 占比（贴 token 成本）vs 按 item 条数（简单）——倾向 char。validate/report-gen 成本要不要也摊（不只 analyze）？倾向先只摊 analyze（大头）。
3. **ROI 阈值**：cost-per-adopted-insight 多高算「低 ROI」？需积累真实数据后定标，初期只展示不告警。
4. **未被引洞察 / 未上报洞察**的成本算谁的？（喂入但没产出被采纳洞察的源 = ROI 趋 0，正是要暴露的——按分母照算、分子为 0）。
5. 是否值得为「精确」做？自托管单人规模下，ROI 可能「看个大概」即够（哪些源常年 0 贡献）——避免过度建模。**建议 MVP：先只做分子（被采纳洞察按源计数）+ 极简分母（按 item 条数摊 analyze 成本），看板展示不告警**，验证够不够用再迭代精确口径。
