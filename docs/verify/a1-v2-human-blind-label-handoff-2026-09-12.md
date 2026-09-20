# A1 v2 consistency — human blind-label handoff

> 状态：等待两份独立 human 盲标；此文件是交接清单，不是完成证明。
> 输入快照：`a1-v2-candidate-20260910-8e23ecf`；范围与原型内部使用限制见 `a1-v2-candidate-snapshot-2026-09-10.md`。

## 唯一 reviewer 输入

每位 reviewer 在各自受控会话中只读取同一 immutable worklist：

`s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-candidate-20260910-8e23ecf/citation-consistency-blind-worklist.jsonl?versionId=CmrA2zEdrnLzFrZOaxEB01ofApFg5UHP`

其 SHA-256 为 `af01ea10806e99d1037b3b050fde745ddb2705e4edd8bc193f686971505d3852`，包含恰好 100 条 `{id, statement, source_text, pair_sha256}`。它不含 AI 标签、生成意图、理由、另一位 reviewer 的结果或裁决建议。

不得向 reviewer 提供相邻的 `citation-consistency-candidates.diagnostic.json`；该 artifact 是仅供后续诊断的 `diagnostic_only` 记录。

## 两位 reviewer 的独立提交

1. 在不知道另一位决定、AI 预判或裁决建议的条件下，逐条标为 `support`、`uncertain` 或 `not_support`。仅当 `not_support` 时填写 `exaggeration`、`out_of_context` 或 `misattribution`。
2. 推荐分别生成可填写 CSV，而不是手改 JSON：`npm run labels:prepare-csv -- <worklist.local.jsonl> <reviewer-a.local.csv>`。每位 reviewer 只填写 `expected_consistency` 和必要的 `negative_type` 两列；`case_id`、pair hash、statement、source_text 是只读证据。完成后由受控 runner 运行 `npm run labels:csv-to-submission -- <worklist.local.jsonl> <filled.local.csv> <opaque-human-id> <submission.local.json>`，转换器会把 100 条决定与 immutable pair hash 绑定。JSON 结构也可参照 `evals/dataset/consistency-human-labels.template.json`。
3. 两份提交冻结前，不得互相交换标签，也不得接触 generator diagnostic。提交与最终 JSONL 不进入 Git。

标签语义与边界以 `evals/dataset/GUIDE.md` 的“引用一致性的标注规则”为准：原文未提及关键属性通常是 `uncertain`，不是 `not_support`；`not_support` 要求 claim 与已有事实冲突、夸大、断章取义或张冠李戴。

## 裁决、receipt 与后续门槛

两份提交冻结后，只把标签不一致的 `case_id` 交给第三位、不同于两位 reviewer 的 **human** adjudicator。对每一项分歧给出最终标签；无分歧项不得裁决。

受控 runner 使用：

```bash
npm run labels:receipt -- \
  <citation-consistency-v2.local.jsonl> <blind-labels.local.json> <consistency-label-receipt.local.json>
```

它会 fail-closed：必须恰有两位不同 human、全量 pair hash 一致、所有分歧都有第三位 human 裁决、最终 JSONL 与决定一致，并达到 100 条、至少 40 条 `not_support` 和三类负例覆盖。`eligible_for_lock` receipt 生成前，不创建 v2 lock、不跑正式完整 A1、更不宣称 Eval-Gate 或 DCP 通过。
