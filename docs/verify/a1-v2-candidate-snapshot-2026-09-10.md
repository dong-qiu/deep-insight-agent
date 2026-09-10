# A1 v2 candidate source snapshot — 2026-09-10

> 状态：`candidate_pending_labels`；**不可提升、不可作为 DCP 或可比 baseline 证据**。  
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

受控 bucket 是私有、versioned、SSE-KMS（专用 CMK）和 Object Lock **Compliance** 的专用 A1 存储；5 个上传对象的 SHA-256 checksum 均由 S3 返回，非公开策略为 `false`。每个对象的 retain-until 均为 `2026-12-09`；lifecycle 只能从第 91 天开始受控清理。没有复用 DR bucket 或 redaction registry。

该 source manifest 仅含 source ID、URL、topic、时间和 body hash，**不含正文**；它还绑定了首次 collection、Simon 单源 retry 和扩大构建的三份无正文证据 manifest。

## 尚未满足的门

1. `license_and_retention.status=pending_source_terms_review`：候选只限内部 A1 质量评测、不得再分发；在各来源条款完成记录前，不能生成 promotable v2 dataset lock。
2. 尚无 100 对的双人一致性标签（其中至少 40 `not_support`，覆盖夸大、断章取义、张冠李戴）；AI 预标注只能是 `diagnostic_only`，不替代该标签。
3. 尚无包含 quality、consistency、display coverage 三个字节指纹的 `verified_v2` lock。
4. 尚无同 commit/config/lock 的两次完整自动 A1 pass，也尚未进行两位人工盲评与第三人裁决。

因此本记录只证明候选原文输入的受控保存和来源覆盖，绝不表示模型质量、来源许可、DCP 或发布批准。
