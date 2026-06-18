---
name: eval-gate
description: >-
  本项目的 AI 输出质量门：在改动 prompt / 模型 / 校验逻辑 / 数据源 / 评测集后，跑对应 eval
  并与 evals/baseline.json 逐指标对比，生成 PR 用对比表，通过后给提交盖 Eval-Gate 章。
  触发：改动命中 src/lib/agents/(analyzer/validator/followup/report-gen)、src/lib/runtime/llm.ts
  (MODELS)、src/lib/sources/、evals/dataset/；或用户说"跑 eval""对比基线""这改动会不会掉指标"；
  或被 pre-push 门禁拦下要求盖章时。这是 L3「修改 prompt/模型/数据源的 PR 必须附 eval 对比」的执行器。
---

# eval-gate — AI 输出质量回归门

`/code-review` 看代码正确性，**不**跑 eval、不懂 baseline 语义。本 skill 是领域专属的 AI 质量门，
与 `.githooks/pre-push` 闭环：**hook 强制"必须跑"，本 skill 负责"怎么跑、怎么比、盖章放行"**。

## 1. 先判断改了什么 → 选 eval

| 改动 | 跑什么 | 要 API key？ |
|---|---|---|
| 仅 validator 纯函数（可达性等） | `npm test`（validator 单测） | 否，CI 可跑 |
| analyzer / validator prompt、`MODELS`、followup、report-gen | `npm run eval:a1` | 是 |
| 批量一致性判定（`judgeConsistencyBatch`） | `tsx evals/validate-batch-judge.ts` | 是 |
| 新增/改数据源（`src/lib/sources/`） | 多源重测（见下）+ `npm run eval:a1` | 是 |

需 key 时确认 worktree 的 `.env.local` 有 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`。
多源重测（不入仓全文，方案 B）：
```bash
npm run seed && npm run eval:build-local
A1_QUALITY_FILE=evals/dataset/insight-quality-multisource.local.jsonl npm run eval:a1
```

## 2. 跑前必查（本项目特有的坑）

- **模型独立性**：`ANALYZER_MODEL` ≠ `VALIDATOR_MODEL`，否则 `assertModelSeparation` 启动即报错。改模型先核这条。
- **数据集规模门**：低于 `MIN_TOPICS=5` / `MIN_CONSISTENCY_PAIRS=100`（`run-a1.ts` 内置）时，
  结论**只能作管线验证，不能作 DCP / 上线判定依据**——别拿种子样本去签门，明确标注。
- **中转站约束**：经第三方中转站需 `VALIDATOR_THINKING=0`（见 operations.md / practice-log）。

## 3. 对比 baseline.json（门禁判据）

读 `evals/baseline.json`，逐项 diff，套规则 **「任一指标较基线降 >3pp → 告警/阻断」**。
**务必分段对比**，两段配置不同，混比会误判：

- `auto_metrics`（arXiv 单源段）：`reachability_pass` `consistency_ok` `consistency_failure`
  `flagged_rate` `judge_accuracy` `judge_neg_recall`
- `multisource`（脏异构内容段）：`reachability_pass` `consistency_ok` 等
- `human_metrics`：`fabrication_rate`（须保持 0）、`non_obvious_ratio`、`untraceable_count`

同时核 `run-a1.ts` 硬阈值（可达性=100%、一致性≥95%、失败≤5%、flagged≤10%、judge 准≥90%、负召≥95%）。
退出码非 0 = 有 FAIL，直接阻断。

## 4. 产出对比表（贴进 PR）

| 指标 | 基线 | 本次 | Δpp | 判定 |
|---|---|---|---|---|
| reachability_pass | 0.983 | … | … | PASS/FAIL |
| consistency_ok | 0.517 | … | … | … |
| …（六项 auto + multisource + human） | | | | |

附：跑的命令、模型配置、数据集规模、成本（`getCostReport`）、以及"为何 PASS/FAIL"一句话。
**若更新了基线**，同步改 `baseline.json` 的 `provenance`（日期/run/config/caveats），别静默覆盖。

## 5. 盖章放行（与 pre-push 闭环）

eval 通过后，给本批某个提交盖 trailer（pre-push 见到即放行整批）：
```bash
git commit --amend --trailer "Eval-Gate: pass (a1 <date>, baseline ok)"
# 或新建一个带该 trailer 的提交
```
- 确认纯重构/注释误命中、无需重测：`Eval-Gate: skip (<原因>)`。
- eval 设施暂不可用、留痕绕过：让用户 `EVAL_GATE_ACK=1 git push`，并提醒 CI 是最终兜底。

> 盖章是「信任承诺」：hook 与 CI 都只校验 trailer 存在、**不验证 eval 真跑过**。它防的是"忘记跑"，
> 挡不住"故意盖章不跑"——后者靠独立 review 与 `eval.yml` 定时回归兜底。盖章前请真的跑过对比。

阈值口径以 `docs/verify/eval-criteria.md` 为准（本 skill 与 `run-a1.ts` 均镜像自它，改阈值同步三处）。
