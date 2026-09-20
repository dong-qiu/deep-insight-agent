# A1 验证切片 (evals)

> 验证 charter 关键假设 **A1**：「LLM 能否从多源噪音中可靠提炼出非显然、可溯源、低幻觉的洞察」。
> 对应 `insight-analysis` AC10、`citation-validation` AC3，是 **DCP-1 → M2 的硬门槛**。

这是一把"尺子"，不是骨架 —— 用最薄的端到端切片（ContentItem → analyzer → validator → 指标）
先证伪 A1，再决定是否投入完整骨架（采集 / 持久化 / UI / 调度等）。

## 跑之前

1. **Node 24+**，安装依赖：`npm install`
   > `package.json` 把 `@anthropic-ai/sdk` 标为 `latest`（要用到 `messages.parse` + `zodOutputFormat`）；
   > 首次安装后建议 `npm ls @anthropic-ai/sdk` 看实际版本并 pin 进 lockfile。
2. **API key**：`cp .env.example .env.local`，填入与 `LLM_PROVIDER` 对应的凭据（默认 Anthropic 可用 `ANTHROPIC_API_KEY`；Volcengine Responses 使用 `LLM_API_KEY` + `LLM_BASE_URL`；`.env*` 已忽略，不入仓）。

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
| 展示引用覆盖 unsafe_accept | 手标 `dataset/display-coverage-benchmark.json`；v6 的最终 statement 必须逐字等于唯一绑定 source quote，并同时核 batch 投影版本、citation index/ref、statement/quote SHA-256。主 validator 对**每个原子 claim 单独请求**，审计内部 claim→quote 边界；独立 coverage 模型只看 quote+locator，判定读者能否脱离标题/正文理解。任何 reject 被放行、投影不等于手标 quote、或任一分批复核错误/缺 verdict 都 FAIL。headline/importance_fact 不进入读者事实投影 | 自动 |
| 非显然洞察占比、幻觉率 | 需人评 → 脚本导出 `out/runs/<run-id>/review-queue.json` | 人工 |

阈值镜像自 `docs/verify/eval-criteria.md`「上线门槛」（改阈值请同步那份文档）。
自动阈值全过只代表可作为两次 run baseline 候选；正式 Eval-Gate 还要求已批准、同配置且指标齐全的
`baseline-registry.json` 基线，因此候选首跑或不可比运行仍以非零退出。任何指标 FAIL、核心样本不完整或无
可评形态同样以非零退出（便于 CI 门禁）。

完整 A1 还要求显式配置且两两不同的 `ANALYZER_MODEL`、`VALIDATOR_MODEL`、`COVERAGE_MODEL`；
后者是展示引用的独立反向复核模型，缺失、相同或不可用都会 fail-closed。不要把密钥或这些本地模型配置提交进仓库。

每次运行写入独立 `out/runs/<run-id>/`（`a1-run.json`、review queue/CSV、`progress.json`、`manifest.json`）；
`out/runs/latest-complete.json` 只是最近完成的指针，必须分别读取 `auto_gate`、`manual_review`、`dcp_eligibility`，不能当作 PASS 标记。
`npm run review:csv` / `npm run review:sheet` 默认沿该指针读取隔离 run 的 review queue；也可显式传入某次 run 的路径。

`manifest.json` 的 `llm_role_telemetry` 除了角色汇总，还在 `by_operation` 按代码固定阶段拆分
（例如 `citation_consistency_batch`、`display_quote_primary`、`display_quote_countercheck`）。`max_tokens`
即使返回 schema-valid tool use 也必须保留；未标记的遗留调用明确归入 `unclassified`，不能与已知阶段混合。
它们生成的是**不含 AI 预标注**的人工盲评输入。三个可选 AI 预标注只能以
`dataset/ai-prelabel-handoff.template.json` 所示的 `diagnostic_only` 形式单独留存，待两份人工提交冻结后再揭示；
它们不得进入 `review:receipt` 或充当第三位裁决者。

排查 relay 或模型长尾时，可用 `A1_QUALITY_LIMIT`、`A1_CONSISTENCY_LIMIT`、
`A1_DISPLAY_COVERAGE_LIMIT`、`A1_QUOTE_SELF_CONTAINED_LIMIT` 暂时限制相应集合。值为 `0`（默认）或不小于
集合规模仍是全量；只有实际截断才会标为 `smoke`。smoke 运行永远不可更新 baseline、不可作 DCP 或发布质量结论。

每个 quality topic 都受 `A1_TOPIC_TIMEOUT_MS` 控制，默认 **25 分钟**（基于 20 个 rich-body 输入约 18 分 27 秒的
真实 liveness 测量）；显式值必须在 30 秒至 45 分钟之间。A1 沿 analyzer 原有的确定性正文分块处理同一主题：每个
分块的模型输出和展示覆盖审计都完成后，才原子写入本地 `quality-checkpoint.json`。到期会取消 analyzer、展示覆盖和
validator 的在途调用；**任何** quality topic 的执行错误（包括 `Request timed out.`、结构化输出残缺和截止超时）都
会停止整次运行，发布该 checkpoint、带当前 topic/chunk/完成计数且无正文的 `progress.json`，以及
`failed/not_evaluated` manifest。半分块绝不入 checkpoint，也绝不跳过主题后产出“完成”结果；失败运行不作为部分样本、baseline 或 DCP 证据。

若要续跑，重新使用**同一完整 quality 数据集和模型配置**，并将 `A1_RESUME_FROM` 指向失败 run 目录（或其中的
`quality-checkpoint.json`）：

```bash
A1_QUALITY_FILE=/controlled/insight-quality-five-topic-100-v2.local.jsonl \
VALIDATOR_THINKING=1 \
A1_RESUME_FROM=evals/out/runs/a1-<failed-run-id> \
npm run eval:a1
```

恢复会校验 prior failed manifest 所记录的 checkpoint SHA-256、完整 `EvalConfig`（含展示引用主审计的输出预算和每请求 claim 数）、quality dataset SHA-256、topic 顺序及
每一 analyzer 分块的输入 hash；任一漂移都会 fail closed。已完成主题不重调 analyzer/validator，未完成主题只复用完整
analyzer 分块，随后仍以完整 topic 运行一次 validator 与 `selectInsights`。`A1_RUNS_DIR` 可将本次 run 目录定向到隔离路径；
resume artifact 只写入本地受控目录，不能提交或外传。

当全量 A1 在 `[分析]` 阶段长时间无产物时，先使用 `npm run eval:analyze-latency-ladder` 走真实 `analyze()` 路径，
按 `A1_LADDER_ITEM_COUNTS=4,8,12,20` 逐级记录仅含 count/hash/耗时的 telemetry。诊断时建议显式设置
`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES=0`、`LLM_TRANSIENT_RETRIES=0`；它不执行一致性 benchmark，也不能生成 baseline 或 DCP 结论。
每个 rung 会先以 `running` 状态落盘、并在 `model_output` 和 `display_coverage` 阶段完成时即时更新；阶段记录只含
耗时、结果与按角色汇总的调用/请求计数，不含正文、URL、端点或凭据。
若需精确重放某个失败 chunk，可显式设 `A1_LADDER_ITEM_OFFSET`（零起始，默认 `0`）；它只改变从同一 topic
选择的连续窗口，仍以输入条目 ID 哈希记录，不得用来抽取或导出正文。

运行时须把 `VALIDATOR_THINKING` 与 `COVERAGE_THINKING` 分开显式配置。先对每个 relay/model
运行 `npm run eval:canary-thinking`：它验证 A1 所用的 **thinking + forced structured tool** 组合，而不是
只验证 API 可达。canary 成功后才可把 validator 设为 `1`；Coverage 模型须自行通过同一组合的 canary，
在此之前保持 `COVERAGE_THINKING=0`。A1 manifest 会记录两角色的有效值、Coverage 值来源和传输版本。

## 数据集

- `dataset/insight-quality.jsonl` —— 每行 `{topic, items, time_window}`，喂给 analyzer。
- `dataset/citation-consistency.jsonl` —— 每行 `{statement, source_text, expected_consistency, negative_type?}`，标注集。
- `dataset/display-coverage-benchmark.json` —— v6 source-quote 投影与 quote 自足性反例；accept 必须同时满足最终 reader-visible 原文自足、逐字投影，且候选草稿/claim 的稳定锚点未与绑定 quote 冲突。所有 accept case 固定 `expected_statement` 为其绑定 quote，防止内部草稿重新泄漏到读者面。

三分类标注口径：`support`=原文明确支持；`not_support`=原文与 claim 有可判定冲突，或原文已有事实被断章取义、夸大、张冠李戴；`uncertain`=原文对关键主体、数值、比较、范围或条件没有足够信息，既不能证实也不能反驳。原文仅仅未提到 claim 时标为 `uncertain`，而不是 `not_support`。

受控 v2 的 consistency JSONL 每行另有稳定 `id`，并用 `npm run labels:receipt` 将最终标签与两份独立 human
盲标、必要的第三人裁决绑定。该 receipt 不含原文；实际 JSONL、blind-label 提交和 receipt 都保留在受控环境。v2
lock 还须通过 `A1_CONSISTENCY_RECEIPT_FILE` 提供该不可变回执的受控本地副本，以校验回执 bytes、human
blind-attestation provenance、最终 JSONL 的 bytes/ID/pair hash 绑定及分布。AI 预标注可用于诊断，但会被 receipt
与 v2 lock 拒绝，不能充当 reviewer 或 adjudicator。

⚠️ A1 的真实 arXiv cohort 已按当前 `dataset/GUIDE.md` 维护；展示覆盖基准是独立的手标安全回归集，不计入 A1 的主题/引用对规模。作 DCP 判定前仍须满足 `eval-criteria.md` 的 **≥ 5 个唯一主题、最终 `reader_visible_by_topic` 中每个主题 ≥ 10 条洞察、≥ 100 组引用-结论对**，且使用 `source-feasibility.md` MVP 清单里的**真实采集内容**；计数以运行 `manifest.json` 的 `dcp_sample` 为准。

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

`collection.json` 记录实际 collector 结果；即使某一个源失败，也会先写入所有已尝试源的成功结果和脱敏失败分类，
然后以非零状态结束。`dataset.json` 分别记录每源的 `eligible` 与 `selected` 数。任一指定源未进入 case，构建即失败。默认 A1 仍要求至少两个不同源；仅当 cohort **恰好指定一个** staged
source 时，允许该源的至少两条内容组成一条隔离发布安全 case。该 cohort 常集中于一个 topic，仍须另跑
满足 5-topic、100-pair 下限的默认 A1，才能签 DCP 或更新全局 baseline。GitHub 的 **Scheduled Eval** 手动触发
也提供 `source_ids` 输入，会在 runner 临时目录完成同一套隔离流程并上传两份 manifest。

产出的多源指标可写入 `baseline.json` 供历史诊断；它不是正式放行依据。正式可比基线必须通过
`npm run baseline:promote -- <manifest.json> <a1-run.json> <stratum>` 写入 `baseline-registry.json`，并由同一
clean commit/config/v2 lock 的第二个不同 run 升为 `dcp_accepted`；记录还必须覆盖该形态全部规范指标键。
内容本身不入仓、可由上述配方重建。

## 模型

默认 分析=`claude-sonnet-4-6` / 校验=`claude-opus-4-7`（架构选型；校验模型必须独立于分析模型，
否则启动即报错）。可用 `ANALYZER_MODEL` / `VALIDATOR_MODEL` 环境变量覆盖。

## 不在本切片范围

采集 / `lib/sources` / 持久化(SQLite) / Job Runner / UI / Docker / cron / 跨批次 `event_id` 对齐 ——
全部待 A1 通过后建骨架时实现（见 `docs/plan/architecture.md`）。
