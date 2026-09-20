# A1 v2 candidate source snapshot — 2026-09-10

> 状态：`candidate_pending_labels`；原型阶段的 source-terms owner decision 已记录，但**不可提升、不可作为 DCP 或可比 baseline 证据**。
> 构建提交：`8e23ecf`；原文不在仓库。

## 已冻结的候选输入

| 项 | 值 |
| --- | --- |
| snapshot id | `a1-v2-candidate-20260910-8e23ecf` |
| input | 100 条 ContentItem，5 个 topic；全局 `content_item_id_or_url` 去重 |
| 每主题 | `t_code_agents`、`t_prompt_injection`、`t_ai_industry`、`t_coding_agent_platforms`、`t_agent_security` 各 20 条 |
| 每来源 | 10 个指定 source 各 10 条 |
| quality JSONL SHA-256 | `6f77758219c21bc0c74a5abe44a5cd94b4f3c880b9bc23848f38dfead22d9a0e` |
| source manifest SHA-256 | `b74fe41e4881c29cc4bf1116953fe3076ab9d054956b0c91cc4a192e35b8666b` |
| manifest immutable reference | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/candidates/a1-v2-candidate-20260910-8e23ecf/source-manifest.json?versionId=lT5PyPAcylH_nJWeaCAks6tHz.OKbZX8` |
| prototype owner decision | `A1-V2-TERMS-PROTOTYPE-20260912` · `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/owner-decisions/a1-v2-terms-prototype-20260912.json?versionId=NeasxfDJ1bQkfx6HOm3j7L3xIjlLu7gA` |
| prototype owner decision SHA-256 | `ac53be0c86f7e4ff79e20af7b6de5e4dfc6943b793e9c7d9d2069f0dac556e2a` |
| generator candidate pairs (not a reviewer handoff) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-candidate-20260910-8e23ecf/citation-consistency-candidates.jsonl?versionId=GFxfpc6oTJ.u5HqXv7ERQdk_2Msn.G8J` |
| candidate pairs SHA-256 | `76fdf8b5cc38491c9624764e09dd090cbaa7fb941fc2977849b8e709fd4e4d74` |
| human blind-label worklist | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-candidate-20260910-8e23ecf/citation-consistency-blind-worklist.jsonl?versionId=CmrA2zEdrnLzFrZOaxEB01ofApFg5UHP` |
| blind worklist SHA-256 | `af01ea10806e99d1037b3b050fde745ddb2705e4edd8bc193f686971505d3852` |
| generator diagnostic (not for reviewers) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/label-candidates/a1-v2-candidate-20260910-8e23ecf/citation-consistency-candidates.diagnostic.json?versionId=JNUqcdLioltJWg2hI8FDo2F1k2oCY5J7` |
| diagnostic SHA-256 | `12ab5dd7b92b6e72895abfedee6c40c28820da0faf85b218aa7fd25257e6169b` |

受控 bucket 是私有、versioned、SSE-KMS（专用 CMK）和 Object Lock **Compliance** 的专用 A1 存储；原始候选快照的 5 个上传对象都已核验，非公开策略为 `false`。上述三个标注流程产物也使用同一 CMK、独立版本和 Compliance retention（candidate 至 `2026-12-11T03:52:00.189Z`、diagnostic 至 `2026-12-11T03:52:01.052Z`、blind worklist 至 `2026-12-11T04:18:43.371Z`）。上传响应给出的 CRC64-NVME 与本地重新计算值一致；它们的 SHA-256 如表所列。lifecycle 只能从第 91 天开始受控清理。没有复用 DR bucket 或 redaction registry。

该 source manifest 仅含 source ID、URL、topic、时间和 body hash，**不含正文**；它还绑定了首次 collection、Simon 单源 retry 和扩大构建的三份无正文证据 manifest。

候选输入恰含 100 个稳定 `id`、待判 `statement`、逐条绑定的 `source_text` window 和 source body hash；它不含 `expected_consistency`、`negative_type`、生成意图或理由。blind worklist 从该文件确定性派生，仅保留 `id`、statement、source_text 和 pair hash，是两位盲标者的唯一数据输入。生成模型、prompt hash 与计划分布只在单独的 `diagnostic_only` 对象中，**不得**交付给两位盲标者。它们都是人工标注流程的受控输入，不是标签、receipt、lock 或模型质量证据。

原型还运行了两个模型不同的 AI reviewer，并将 16 条分歧抽为不含 AI verdict 的 human adjudication worklist；完整的 immutable references、hash、配置和限制见 `a1-v2-prototype-ai-assisted-label-flow-2026-09-12.md`。该路径固定 `lock_eligible=false`，不改变下列正式 v2 门槛。

## 尚未满足的门

1. 原型 owner 已在受控、Compliance-retained record 中对这一个候选快照作 `approved_all` 决策：仅限内部 A1 质量评测、人工标签与模型评测；禁止再分发、训练或生产发布。它不构成法律意见或正式发布许可，正式发布前必须由 source-specific 条款/许可和独立记录替换。
2. 尚无 100 对的双人一致性标签（其中至少 40 `not_support`，覆盖夸大、断章取义、张冠李戴）；AI 预标注只能是 `diagnostic_only`，不替代该标签。最终 JSONL 还必须有两份 human 盲标与必要第三人裁决绑定的 `eligible_for_lock` receipt。
3. 尚无包含 quality、consistency、display coverage 三个字节指纹、source decision 与标签 receipt 的 `verified_v2` lock。
4. 尚无同 commit/config/lock 的两次完整自动 A1 pass，也尚未进行两位人工盲评与第三人裁决。

因此本记录证明候选原文输入的受控保存、来源覆盖和原型 owner 的内部使用决策；绝不表示模型质量、外部来源许可、DCP 或发布批准。
