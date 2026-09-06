# Spec: Daily Brief 选择漏斗可观测性

> V1 · 状态：🟡 Implemented，待生产验收 · 2026-09-06

## 背景

日报可能在“采集正常、引用校验正常”的情况下仍显得偏薄：候选在选择上限处截断，或已通过校验的洞察被新鲜度门和已发布事件去重过滤。单份报告已有 Trace，但运营者无法横向判断是输入不足、来源集中、校验损失还是确定性发布门导致，也没有针对“输入充足却产出偏薄”的信号。

## 决定与边界

1. 选择阶段向既有 P0 `generation_event(select.completed|skipped)` 追加**仅计数**的受控指标：候选内容/来源、选中内容/来源、近期候选/选中。不得记录标题、URL、正文、prompt、token 或来源列表。
2. 管理看板从 `report + generation_effect + generation_event` 做最近 14 份已完成 Brief 的有界只读投影，展示：候选→选中、分析→可纳入、校验、鲜度/去重过滤、最终洞察/引用。没有 Trace 的旧报告显示 `—`，不得当作 0。
3. 默认薄报告口径为“选中 `>=10`、最终发布 `<=2`”；可通过 `BRIEF_THIN_MIN_SELECTED` 与 `BRIEF_THIN_MAX_PUBLISHED` 调整。它只触发运维复核，**不**自动提高选择上限、放宽新鲜度、绕过事件去重，或降低 `pass/support` 引用白名单。
4. 每个报告 ID 在单个进程内最多投递一次薄报告通知。`BRIEF_THIN_REPORT_ALERT=0` 可关闭；通知渠道仍复用现有 `ALERT_WEBHOOK`，未配置时无外发。
5. 该投影不依赖 P1 metrics/integrity 的运行时准入，因此在 P1 仍隔离时也可用于日报运营；不引入新表、迁移或写入旁路。

## 验收标准

- 相同输入下，`selectAnalysisItems` 的返回结果不变；诊断准确报告候选、选中和近期计数。
- Trace API 与报告溯源面板显示新登记指标；未知/旧指标不外泄。
- 管理看板对有 Trace 的 Brief 正确合并各阶段计数，对 legacy Brief 显示未知值。
- 输入不足不告警；输入满足下限且发布不超过阈值时，通知含主题、报告/Trace、选择、校验、过滤和最终发布计数；关闭开关后不通知。
- 测试覆盖选择回归、受控 trace 指标、诊断投影与告警去重；运行相关测试及 `npm run typecheck`。本变更不修改模型、prompt、数据源、选择策略或 validator，`Eval-Gate: skip (仅增加确定性计数投影与运维通知)`。
