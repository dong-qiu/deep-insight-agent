# Spec: 洞察身份与去重

> 范围：分析、发布选择与图谱下钻中的严格身份对齐。状态：实施中 · 2026-09-08

## 背景与目标

同一现实事件可能在分块分析、缓存复用或历史批次中以重复 Insight occurrence 出现；历史数据也可能已存在分裂的 `event_id`。系统需要减少重复发布和重复展示，但不能把相似措辞误当作同一事实，更不能合并不同 occurrence 的引用。

目标是以可审计、确定性的严格 statement 指纹作为**兜底**身份防线；LLM 的语义事件对齐仍是主路径。

## 用户故事

- As a 读者, I want Daily Brief 不重复发布同一已验证事件, so that 我看到的是新增证据或新的事件。
- As a 审计者, I want 每个合并展示项仍能展开所有原始 occurrence 与报告链接, so that 去重不会损失可追溯性。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | 当前 `AnalysisBatch`、最近 14 天已发布 `brief` / `initial_digest` occurrence、每条 occurrence 的 `pass/support` citation evidence |
| 身份键 | `Insight.type + "\\0" + statementFingerprint(statement)`；指纹仅归一空白与 `text-normalize` 已定义的等价排版字符，不做语义相似度、关键词匹配或跨类型合并 |
| 输出 | 保留完整 `Insight[]` occurrence；发布选择的确定性代表项及过滤计数；图谱下钻的 read-time 分组和完整 occurrence / report-link 列表 |
| 触发 | `runAnalysis` 在缓存命中与新分析合并后；`runReportGen` 在校验白名单之后；图谱 drill API 读取时 |

## 行为规约

1. `event_id` 对齐以模型判断为主。仅当同一类型的严格指纹在历史中对应**唯一** `event_id` 时，确定性回退可复用该 ID；多个历史 ID 匹配时保持模型结果，不强行合并。
2. 分块结果、缓存命中和新分析结果全部汇合后才执行当前批次对齐。对齐只改 `event_id` / `is_followup`，绝不删除 occurrence、改写 statement 或拼接 Citation。
3. brief 先应用 `pass/support` 引用白名单，再在当前批次按 `event_id`（无 ID 时按严格指纹）选出确定性代表项：重要性更高优先，其次可发布引用数更多，最后按 Insight ID 排序。代表项只携带自身的白名单引用。
4. 对最近 14 天已发布 occurrence，若当前 Insight 没有自身新增的 `pass/support` `content_item_id`，则不发布。同一严格指纹可作为遗留分裂 `event_id` 的兜底；它不替代模型的语义事件对齐。
5. 图谱 drill 仅在读取展示时折叠同类型、同严格指纹 occurrence；图数据、报告、原始 Insight 与 citation 记录均不修改。分组必须暴露 occurrence 数、每个原始 Insight 和其全部已发布报告链接。
6. 选择诊断和 provenance timeline 记录 `batch_duplicate_filtered_count` 与 `fingerprint_duplicate_filtered_count`。计数不得把 blocked、flagged 或未入白名单的引用视为已发布证据。

## 验收标准 (AC)

- [ ] AC1: 同一批次中，同类型且仅空白/已定义排版折叠后相同的 statement 取得同一 `event_id`；每条 Insight 和其 Citation occurrence 均仍被落库。
- [ ] AC2: 唯一历史严格指纹匹配可覆盖模型产生的新 ID 并标记 follow-up；跨类型或多历史 ID 冲突时不得自动复用或合并。
- [ ] AC3: Daily Brief 在 `pass/support` 白名单之后，对重复当前事件只发布一个按规则确定的代表项；代表项不得带入被过滤 occurrence 的引用。
- [ ] AC4: 给定最近 14 天已发布的同严格指纹 occurrence，且当前项没有自身新增的成功校验引用时，Brief 不发布该项并记录指纹过滤计数；有新增成功引用时可作为更新发布。
- [ ] AC5: 图谱 drill 将严格重复项折叠为一个展示组，同时可返回每条原始 occurrence、其 quote 和所有已发布报告链接；没有报告链接的 occurrence 仍可见但不伪造链接。
- [ ] AC6: 过滤计数通过生成 provenance、报告选择诊断和 timeline 三条读取路径可见；固定 `asOf` 时 14 天历史窗口可复现。

## 非功能要求

- 正确性：严格指纹只作 deterministic fallback，不得宣称语义等价或现实事件等价。
- 可追溯性：去重不得删除或混合 citation occurrence；发布证据仅来自 `pass/support` 白名单。
- 性能：指纹与分组均为内存线性处理；不增加 LLM 调用。

## 依赖与影响范围

- 上游：`insight-analysis` 的事件对齐与分析缓存。
- 下游：`citation-validation` 白名单、`report-generation`、报告/provenance 查询和图谱 drill UI。
- 代码：`analyzer.ts`、`pipeline.ts`、`report-gen.ts`、`reports.ts`、`graph.ts` 与对应测试。

## 非目标

- 不引入语义向量、关键词或 LLM 二次判重。
- 不迁移或重写历史 `event_id`。
- 不改变图谱边权、原始 Insight 存储或发布报告正文。
