# A1 v2 prototype AI-assisted consistency labels

> 状态：两位 AI review 与比较已完成，等待一位 human 对 16 条分歧作盲裁决；该流程永远不是 v2 lock / baseline / DCP 证据。

## 目的与隔离边界

为降低原型人工工作量，两个模型不同的 AI reviewer 各自审阅全部 100 条 blind worklist；human 只裁决 AI 不一致的条目。AI reviewer、比较 receipt、人工 dispute CSV、裁决和最终 JSONL 都留在受控环境，且不进入 Git。

当前本地配置会使用：

| reviewer | role | model | Thinking |
| --- | --- | --- | --- |
| `ai-validator` | `validator` | `claude-opus-4-8` | on (`VALIDATOR_THINKING=1`) |
| `ai-coverage` | `coverage` | `claude-opus-4-6` | off (`COVERAGE_THINKING=0`) |

工具会拒绝同模型或同 role 的“两份 review”，也会拒绝漏项、pair hash 不匹配、AI 标签/type 不匹配和把 AI 标签带入 human dispute worklist 的情况。

## 2026-09-12 已完成的受控产物

| artifact | immutable reference | SHA-256 |
| --- | --- | --- |
| validator AI submission | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-candidate-20260910-8e23ecf/ai-validator-review.json?versionId=K1__ogTXMHA1lXIqeJiqPf7MaLA_8FRC` | `5cbb0bcc08bd595588916b176e7cf6655c35ed62c926b4745c47ded7777c801e` |
| coverage AI submission | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-candidate-20260910-8e23ecf/ai-coverage-review.json?versionId=IPz8s5XzylEpBLmpkN16qqTileAWjh7t` | `ea254658001fcc520e6884ba6d168cff0e8602d48391fcdd845bd7934ba35868` |
| AI comparison receipt (no decisions) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-candidate-20260910-8e23ecf/ai-comparison-receipt.json?versionId=EsEZbLYoIdJM7hPTaVH4ScoXCzaRvHnW` | `5cee76e9a2fb9104a531a159fae7fd38474f362dc16c862db84d7278ab4b1f24` |
| human dispute worklist (16 pairs, no AI labels) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-candidate-20260910-8e23ecf/human-adjudication-worklist.jsonl?versionId=L5nn04P4u8YvtUi.ZqqEndrpr9.CiGKN` | `5d8be6c334a4e132a51f3cda8fac08270a32ba2b82a5afc6386d9aa0a4c6d799` |
| human adjudication CSV (16 blank rows) | `s3://deep-insight-a1-eval-snapshots-787182418634/a1-v2/ai-assisted/a1-v2-candidate-20260910-8e23ecf/human-adjudication.csv?versionId=31W.FJbGDvcN_uOXAxzzIl7HtB3itS08` | `f417cb413653e6f20887de66d8e68cf2bfc15947f5d6226f0dbe7c22645b328a` |

两位 AI 在 100 条中有 **16 条**标签或 negative type 分歧。comparison receipt 为 `prototype_ai_assisted`、`lock_eligible=false`，不含逐条 AI decision；human worklist/CSV 也不含 AI decision。五个对象均为 SSE-KMS、versioned、Object Lock Compliance，retain-until 在 `2026-12-11T13:52:49Z` 至 `2026-12-11T13:52:52Z`。

## 受控执行顺序

```bash
npm run labels:ai-review -- \
  evals/dataset/citation-consistency-v2-blind-worklist.local.jsonl validator \
  evals/dataset/citation-consistency-v2-ai-validator.local.json

npm run labels:ai-review -- \
  evals/dataset/citation-consistency-v2-blind-worklist.local.jsonl coverage \
  evals/dataset/citation-consistency-v2-ai-coverage.local.json

npm run labels:ai-compare -- \
  evals/dataset/citation-consistency-v2-blind-worklist.local.jsonl \
  evals/dataset/citation-consistency-v2-ai-validator.local.json \
  evals/dataset/citation-consistency-v2-ai-coverage.local.json \
  evals/dataset/citation-consistency-v2-ai-disputes.local.jsonl \
  evals/dataset/citation-consistency-v2-ai-comparison-receipt.local.json
```

比较后，只有存在分歧时才生成并交给 human：

```bash
npm run labels:ai-dispute-csv -- \
  evals/dataset/citation-consistency-v2-ai-disputes.local.jsonl \
  evals/dataset/citation-consistency-v2-human-adjudication.local.csv
```

human 只填写 `expected_consistency` 和必要的 `negative_type`，再转换并完成暂定标签：

```bash
npm run labels:ai-dispute-to-adjudication -- \
  evals/dataset/citation-consistency-v2-ai-disputes.local.jsonl \
  evals/dataset/citation-consistency-v2-human-adjudication.local.csv \
  <opaque-human-adjudicator-id> \
  evals/dataset/citation-consistency-v2-human-adjudication.local.json

npm run labels:ai-finalize -- \
  evals/dataset/citation-consistency-v2-blind-worklist.local.jsonl \
  evals/dataset/citation-consistency-v2-ai-validator.local.json \
  evals/dataset/citation-consistency-v2-ai-coverage.local.json \
  evals/dataset/citation-consistency-v2-human-adjudication.local.json \
  evals/dataset/citation-consistency-v2-ai-assisted-final.local.jsonl \
  evals/dataset/citation-consistency-v2-ai-assisted-final-receipt.local.json
```

最终 receipt 固定写入 `lock_eligible: false`。`labels:receipt` 与 v2 dataset lock 仍只接受两位完整 human 盲标加必要第三人裁决的正式 evidence；不得把本流程的结果改名或转写为 `eligible_for_lock`。
