# Spec: 报告质量复盘链路

> V1 · 状态：🟡 Implementing · 2026-09-11

## 目标

让管理员能按一次报告生成的真实输入、阶段、候选、引用校验和确定性选择结果复盘报告质量。该能力是内部质量复盘，**不是**网页原件存证、LLM 重放、法律审计或来源许可结论。

## 范围与边界

V1 只为启用后、有完整 generation trace 的已发布报告提供 `complete` 复盘。历史报告不回填：缺少所需 trace/revision/冻结配置的报告显示 `legacy` 或 `partial`。

V1 不新增或返回以下内容：正文、`raw_ref`、网页 HTML、完整 LLM prompt、原始模型 response、密钥、环境变量、完整 candidate-audit JSON。引用只复用既有 `citation.quote` / `locator`，管理员读模型仍必须做长度限制和分页。

## 事实来源

```text
analyze.started.input_refs (有序分析输入集合)
  → content-v4 provenance_revision (输入元数据与正文 hash，不含正文)
  → display_coverage_candidate_audit (Insight 前的 coverage 候选)
  → analysis_batch / insight / citation / citation_check
  → report_selection_decision (每个已落库 Insight 的报告终态)
  → report_review_snapshot (Report 与 trace / event / batch 的绑定)
  → report
```

`report_review_snapshot` 是绑定与完备性索引，不复制输入、模型配置或引用内容。模型与规则版本由受控的 `generation_event.version_context` 冻结。

分析缓存打开时，`analyze.started.input_refs` 表示“分析输入集合”，不等于本次逐项发送到模型的内容；页面须展示缓存模式和 `analysis_cache_hit_item_count` / `analysis_cache_miss_item_count`。当 `analysis_cache_read_bypassed=1` 时页面显示“本轮未查读缓存”，不得把 `0/0` 解释为没有缓存命中，也不得宣称可逐请求重放。

## 数据契约

### content-v4 revision

新采集/分析输入的内容 revision 固定：`url`、`source_id`、`title`、`published_at`、`fetched_at`、`body_kind`、`fetch_status`、`body_length`、`content_hash`。不得加入正文、raw 文件路径或 HTML。旧 `content-v3` 仍可读，不能回填。

### report_review_snapshot

一份已发布报告一个 snapshot，绑定 `trace_id`、`analysis_batch_id`、`analyze_started_event_id`、`analyze_completed_event_id`、`validate_started_event_id`、`validate_completed_event_id`、`generate_report_started_event_id`、`selection_rule_version`、`review_trace_status` 与 `publication_state`。校验完成事件复用校验开始时已冻结的受控配置，不能在模型调用后重读环境变量。

### report_selection_decision

每个 `analysis_batch.insight` 对应一条终态：`published` 或 `excluded`。记录受控 `reason_code`、可选同批 `related_insight_id`、发布顺位与既有 citation index 列表。原因码只能映射已实现选择分支；不得使用尚不存在的总量上限或把整批失败伪装成单条洞察决定。

`display_coverage_candidate_audit` 与此表是两层记录：前者可能没有 Insight，后者只覆盖持久化 Insight；两者不得混为一谈。

## 发布协议

生成报告时先在 report intent 事务写入 `report(generating)`、generation effect、planned review snapshot 和完整 decision 集合。最终发布、普通恢复与 anchored 恢复共用校验：effect 的 `trace_id` 与 `event_id` 必须同时存在，且分别精确等于 snapshot 的 `trace_id` 与 `generate_report_started_event_id`；事件同 trace、analysis/validation batch 一致、分析与校验 input refs 一致、输入 refs 可解析、三阶段受控配置完整且校验开始/完成配置一致、每条 Insight 恰有一个决定、published 决定有序集合等于 `report.insight_ids`、发布引用仍为 `pass + support`。任一失败不得将报告置为 `done`；恢复中发现单边 provenance 时，将 effect 标记为不可恢复，anchored effect 同时停止重试。

`planned` review 数据不经 reader 路径暴露。报告删除、redaction、归档/purge 必须使 review 数据遵循同一可见性和最终清理生命周期。

## 权限与界面

复盘入口为 `/admin/reports/:id/review`。middleware 路径闸和服务端查询/API 均要求 admin；非 admin、非 done 或未发布 snapshot 的报告统一 404。页面展示：概览、分析输入集合、coverage 候选、Insight 决定、引用校验、受控配置和时间线。它不重新抓取外部网页。

## 验收标准

1. 新的 complete 报告可从页面逐层看到冻结输入、候选、校验、决定和最终输出；历史数据不伪回填。
2. `published` decision 的有序 Insight 集合严格等于 `report.insight_ids`，每个 batch Insight 恰有一个终态。
3. 同一 fixture 下，选择重构前后的 Markdown、HTML、引用、索引和通知输入保持不变。
4. 初次发布、effect recovery、anchored recovery 都无法发布缺 review package 的报告。
5. viewer / 未认证用户不能获取复盘元数据；所有 DTO 负向断言不含禁止字段。
6. content 更新后，复盘读取的是历史 v4 revision，不把当前行当作历史输入。
7. 改动 Analyzer/Validator 运行配置记录后按 Eval-Gate 做无行为回归；确定性报告路径以生产接线测试为证据。
