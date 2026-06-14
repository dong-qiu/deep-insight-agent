# Spec: 报告生成 (Report Generation)

> M1 计划阶段产物 · MVP 范围 · 状态：🟠 评审中 · 2026-05-20

## 背景与目标

MVP 端到端管线的输出段。把校验后的洞察组织成用户可读、可溯源的报告。
对应核心能力「报告」。MVP 三类报告：每日 **brief**、首版 **initial_digest**、主题 **deep_dive**。

## 用户故事

- As a 用户, I want 每天一份 brief 用 5 分钟掌握关键事, so that 我能持续追踪而不被信息淹没。
- As a 用户, I want 输入一个主题 → 约 10 分钟内拿到结构化、可溯源的深挖报告, so that 我能快速产出可交付的综述。

## 输入 / 输出契约

| 项 | 说明 |
|---|---|
| 输入 | `AnalysisBatch` 及其 `ValidationResult`（字段见 `architecture.md`「数据模型」）—— 按「洞察级纳入判定」纳入洞察。`brief` 消费定时分析批次；`deep_dive` 触发时同步触发新分析（见行为规约 3） |
| 输出 | `Report` + `ReportIndexEntry`（字段见 `architecture.md`「数据模型」）；正文 Markdown / 自包含 HTML；按主题 + 日期归档并入全局索引 |
| 触发 | 定时（每日 brief）/ 按主题手动（深挖） |

## 行为规约

1. brief：按 `Topic` 输出周期概览；通过 `Insight.event_id` 判重 —— 不复报已在**历史 `brief` 或 `initial_digest`**（合并构成「不复报基线」）出现过的事件；同 `event_id` 的后续进展作为「更新」再现，`Report.prev_report_id` 指向最近一篇含该事件的报告。
2. 首份 brief 为 `type=initial_digest`：对回填的历史内容做信号去噪后输出重点（**受第 7 项规模上限约束，非全量摊开**），并把覆盖的 `event_ids` 写入「不复报」基线；之后的 brief 为 `type=brief`。
3. 深挖：用户提交深挖请求时**同步触发一次** `insight-analysis`（时间窗 = 该 `Topic` 最近 90 天，可配置）+ `citation-validation`；以产出的 `AnalysisBatch` + `ValidationResult` 为输入，围绕单一 `Topic` 输出 `type=deep_dive` 的完整结构化报告。
4. 无重要事件（输入 `AnalysisBatch.no_significant_event=true`、`releasable=true`）时，brief 诚实输出「无重要事件」，**`Report.status=done`，不置 failed**；批次失败（`status=failed`）或不可放行（`releasable=false`）时报告置 `failed`。
5. 洞察纳入按 `architecture.md`「校验结果 · 洞察级纳入判定」：剔除 `blocked` 引用后仍有支撑的洞察纳入，含 `flagged` 引用的洞察标「待核实」；每条结论标引用编号、行内可点回原文。
6. 报告状态按 `architecture.md` `Report.status` 流转：`generating` →（`done` | `failed`）；`failed` 可重跑回 `generating`；`done` → `archived`。`deleted` 转换由报告管理 / 看板触发，**不在本段职责内**（属阅读 UI / 看板 spec）。
7. 报告规模：`brief` 关键事件 ≤ 12 条、每条摘要 ≤ 120 字（**暂定值；M1 末以 `eval-criteria.md`「简洁性」维度的人评 + 实际阅读计时校准**），作为「5 分钟可读」的代理指标；`initial_digest` 同此上限。`deep_dive` 为完整六段（TL;DR + 关键发现 + 趋势分析 + 对比表 + 时间线 + 引用清单）。brief 正文精简，不套用对比表 / 时间线全套。
8. 报告按主题 + 日期归档，产出 `ReportIndexEntry` 入全局索引（**派生字段（`source_ids` / `importance` / `entity_names` / `tags`）规则见 `architecture.md`「数据模型 · ReportIndexEntry · 派生规则」**）；索引支撑全文搜索（标题 + 正文 + 摘要）与多维筛选 / 排序。
9. 输出 Markdown 与自包含 HTML 两种格式；存储 MVP 用文件系统（Markdown 正文 + JSON 索引）。

## 验收标准 (AC)

- [ ] AC1: 定时触发后按 `Topic` 生成当日 `brief`，含 `Report` 必填字段；关键事件 ≤ 12 条、每条摘要 ≤ 120 字（暂定阈值，M1 标定）。
- [ ] AC2: brief 不含 `event_id` 已在**历史 `brief` 或 `initial_digest`**（合并基线）出现过的事件；同事件后续进展标「更新」，`prev_report_id` 指向正确的历史报告。
- [ ] AC3: 在 `eval-criteria.md` 规定的「深挖时延语料」上连续 N = 10 次主题深挖，端到端时延 P50 ≤ 10 分钟（起点 = 用户提交深挖请求，终点 = `Report.status` 置 `done`）。
- [ ] AC4: 报告 100% 的结论带可点引用；洞察按「洞察级纳入判定」纳入，含 `flagged` 的标「待核实」，无 `blocked` 内容。
- [ ] AC5: 报告 Markdown / HTML 均正确输出，HTML 自包含（离线可读）。
- [ ] AC6: 报告入库后可被全文搜索（标题 / 正文 / 摘要）检索到，并可按主题 / 日期 / 来源 / 标签筛选、按时间 / 重要性排序。
- [ ] AC7: 首次运行产出 `type=initial_digest`，受 AC1 同等规模上限约束（非全量摊开），带「初始摘要」标识；其覆盖事件写入「不复报」基线。
- [ ] AC8: 无重要事件且校验放行（`no_significant_event=true` + `releasable=true`）时，brief 输出明确的「无重要事件」、`Report.status=done`，**不置 failed**；批次失败或不可放行时 `Report.status=failed`。
- [ ] AC9: 单份报告平均生成成本按 `Report.type` 分别 ≤ `eval-criteria.md` 阈值（**2026-05-27 按 Opus-on-relay 含校验口径重标**：`deep_dive` ≤ ¥15；`brief` ≤ ¥5；`initial_digest` ≤ ¥30。原 ¥3.0/¥0.5/¥8.0 假设 analyzer=Sonnet 且 analyze-only，已废）。阈值以 `eval-criteria.md` 为单一事实源。
- [ ] AC10: 报告状态正确流转 —— 生成成功置 `done`、失败置 `failed`（可重跑回 `generating`）、归档置 `archived`，与管理看板一致。

## 非功能要求

- 性能：本段（报告生成）时延预算 ≤ 1.5 分钟；端到端「主题深挖」P50 ≤ 10 分钟由 分析(≤6) + 校验(≤2.5) + 报告(≤1.5) 三段共担。
- 成本：每类报告各自的预算阈值见 `eval-criteria.md`。
- 可观测性：报告生命周期状态、耗时、成本、引用数可在管理看板看到。

## 依赖与影响范围

- 依赖：`insight-analysis` 的 `AnalysisBatch`、`citation-validation` 的 `ValidationResult`；数据模型见 `architecture.md`；成本阈值与深挖时延语料见 `eval-criteria.md`。
- 影响：报告生成逻辑、`src/app/api/` 报告相关路由、文件系统归档与索引。
- 下游：报告阅读 UI（第二批 spec）消费 `Report` / `ReportIndexEntry`。

## 开放问题

- 文件系统归档的目录结构与 JSON 索引落盘格式（与 `architecture.md`、`data-collection` 归档约定统一）。
- 报告阅读 UI 与账号体系单独成 spec（第二批）。
- 「今日 Brief 落地页」对多份按 `Topic` 生成的 brief 的聚合呈现属阅读 UI（第二批 spec）职责。
