# A1 验证切片 (evals)

> 验证 charter 关键假设 **A1**：「LLM 能否从多源噪音中可靠提炼出非显然、可溯源、低幻觉的洞察」。
> 对应 `insight-analysis` AC10、`citation-validation` AC3，是 **DCP-1 → M2 的硬门槛**。

这是一把"尺子"，不是骨架 —— 用最薄的端到端切片（ContentItem → analyzer → validator → 指标）
先证伪 A1，再决定是否投入完整骨架（采集 / 持久化 / UI / 调度等）。

## 跑之前

1. **Node 24+**，安装依赖：`npm install`
   > `package.json` 把 `@anthropic-ai/sdk` 标为 `latest`（要用到 `messages.parse` + `zodOutputFormat`）；
   > 首次安装后建议 `npm ls @anthropic-ai/sdk` 看实际版本并 pin 进 lockfile。
2. **API key**：`cp .env.example .env.local`，填入 `ANTHROPIC_API_KEY`（`.env*` 已忽略，不入仓）。

## 跑

```bash
npm run eval:a1     # A1 实跑（需 API key，调真模型）
npm test            # validator 纯函数单测（无需 key，CI 可跑）
npm run typecheck   # tsc 类型检查
```

## 它测什么

| 指标 | 来源 | 自动/人工 |
|---|---|---|
| 引用可达性通过率 | validator 确定性校验（quote 是否逐字在原文） | 自动 |
| 引用一致性合格率 / 失败率 / flagged 率 | validator LLM 一致性评判 | 自动 |
| 校验器端到端三分类准确率 / 负例召回率 / 完成率 | 标注集 `citation-consistency.jsonl`；经生产单条路径的重试，失败按未命中计入前两项 | 自动 |
| 展示引用覆盖 unsafe_accept | 手标 `dataset/display-coverage-benchmark.json`；先验证 statement→唯一 citation claim 的显式绑定，再验证 claim→displayed quote/span；任一 reject 被放行即 FAIL | 自动 |
| 非显然洞察占比、幻觉率 | 需人评 → 脚本导出 `out/runs/<run-id>/review-queue.json` | 人工 |

阈值镜像自 `docs/verify/eval-criteria.md`「上线门槛」（改阈值请同步那份文档）。
自动门槛全过 → 退出码 0；有 FAIL → 退出码 1（便于 CI 门禁）。

每次运行写入独立 `out/runs/<run-id>/`（`a1-run.json`、review queue/CSV、`manifest.json`）；
`out/runs/latest-complete.json` 只是最近完成的指针，必须分别读取 `auto_gate`、`manual_review`、`dcp_eligibility`，不能当作 PASS 标记。

## 数据集

- `dataset/insight-quality.jsonl` —— 每行 `{topic, items, time_window}`，喂给 analyzer。
- `dataset/citation-consistency.jsonl` —— 每行 `{statement, source_text, expected_consistency, negative_type?}`，标注集。

三分类标注口径：`support`=原文明确支持；`not_support`=原文与 claim 有可判定冲突，或原文已有事实被断章取义、夸大、张冠李戴；`uncertain`=原文对关键主体、数值、比较、范围或条件没有足够信息，既不能证实也不能反驳。原文仅仅未提到 claim 时标为 `uncertain`，而不是 `not_support`。

⚠️ **当前是 2 个主题 + 5 组标注的种子样本，仅够验证管线打通。**
作 DCP 判定前须扩到 eval-criteria 规模：**≥ 5 主题 × ≥ 10 洞察、≥ 100 组引用-结论对**，
且用 `source-feasibility.md` MVP 清单里的**真实采集内容**（种子样本是示意，非真实数据）。

👉 怎么填：见 **`dataset/GUIDE.md`**（目标规模、取数来源、格式、引用一致性 3 类负例的标注规则与 checklist）。

### 本地多源评测（M3-2 · 方案 B：不入仓）

验证 A1 在**非 arXiv 异构内容**下是否稳健，但**不把第三方全文提交进仓库**（项目原则「不复制全文存储」）。
内容留本地（`dataset/*.local.jsonl` 已 gitignore），只提交配方/代码与指标/基线。

```bash
npm run seed                 # 播种 23 源 + 2 主题
# （采集：触发 /api/cron 或既有 .data；F1 限流，每 RSS 源 ≤50）
npm run eval:build-local     # 从 .data 抽多源富内容 → dataset/insight-quality-multisource.local.jsonl
A1_QUALITY_FILE=evals/dataset/insight-quality-multisource.local.jsonl npm run eval:a1   # 多源重测
```

### Staged source cohort（隔离真采集）

新源不能只用既有 `.data` 抽样证明质量：它可能根本没有进入样本。对尚未启用的 source，先在**临时**
SQLite 与原文目录中走生产 `collectSource`，再要求每个指定源实际进入生成的 A1 case：

```bash
cohort_dir="$(mktemp -d)"
export EVAL_ISOLATED_ROOT="$cohort_dir"
export DB_PATH="$cohort_dir/insight.db"
export DATA_DIR="$cohort_dir/data"
export EVAL_SOURCE_IDS="src_one,src_two,src_three"
export EVAL_COHORT_COLLECTION_MANIFEST="$cohort_dir/collection.json"
npm run eval:collect-source-cohort

export EVAL_REQUIRED_SOURCE_IDS="$EVAL_SOURCE_IDS"
export EVAL_MIN_BODY=400
export EVAL_LOCAL_OUT="$cohort_dir/insight-quality.jsonl"
export EVAL_SOURCE_COHORT_MANIFEST="$cohort_dir/dataset.json"
npm run eval:build-local
A1_QUALITY_FILE="$EVAL_LOCAL_OUT" npm run eval:a1
```

`collection.json` 记录实际 collector 结果；`dataset.json` 分别记录每源的 `eligible` 与 `selected` 数。
任一指定源未进入 case，构建即失败。默认 A1 仍要求至少两个不同源；仅当 cohort **恰好指定一个** staged
source 时，允许该源的至少两条内容组成一条隔离发布安全 case。该 cohort 常集中于一个 topic，仍须另跑
满足 5-topic、100-pair 下限的默认 A1，才能签 DCP 或更新全局 baseline。GitHub 的 **Scheduled Eval** 手动触发
也提供 `source_ids` 输入，会在 runner 临时目录完成同一套隔离流程并上传两份 manifest。

产出的多源指标写入 `baseline.json`（多源段）；内容本身不入仓、可由上述配方重建。

## 模型

默认 分析=`claude-sonnet-4-6` / 校验=`claude-opus-4-7`（架构选型；校验模型必须独立于分析模型，
否则启动即报错）。可用 `ANALYZER_MODEL` / `VALIDATOR_MODEL` 环境变量覆盖。

## 不在本切片范围

采集 / `lib/sources` / 持久化(SQLite) / Job Runner / UI / Docker / cron / 跨批次 `event_id` 对齐 ——
全部待 A1 通过后建骨架时实现（见 `docs/plan/architecture.md`）。
