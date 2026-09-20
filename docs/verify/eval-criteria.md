# AI 输出评分标准

> 洞察 / 校验 / 报告类 AI 输出的质量评估维度与判定方法。
> 本文件是各 spec 中所有「阈值见 `eval-criteria.md`」的落点。
> 状态：🟡 初稿 · 2026-05-18 · 阈值为 M1 暂定值，M1 末随真实数据标定。
> 2026-05-25 据 A1 实跑校准「非显然」门槛（硬门槛 → 追求层）；可达性 / 幻觉两条红线不动。

## 评分维度

洞察 / 报告输出的人评 + 自评维度：

| 维度 | 说明 | 权重 | 评分方式 |
|---|---|---|---|
| 准确性 | 事实与引用是否正确（含引用一致性） | 35% | 自评 + 人评 |
| 新颖性 | 是否提供非显然的信号 | 25% | 人评 |
| 可操作性 | 用户能否据此行动 | 15% | 人评 |
| 一致性 | 同输入是否稳定输出 | 15% | 多次重跑 |
| 简洁性 | 是否冗余 | 10% | 长度 + 人评 |

综合分 = 各维度加权（每维度 0–5 分，归一到 0–100）。

## 评测集

| 评测集 | 用途 | 规模（MVP 暂定） | 来源 |
|---|---|---|---|
| 洞察质量集 | 洞察综合评分、A1 验证 | ≥ 5 个唯一主题，最终 `reader_visible_by_topic` 中每个主题 ≥ 10 条洞察 | 真实采集数据，人工标注 |
| 引用一致性集 | citation-validation 一致性准召 | ≥ 100 组「引用-结论」对，正例 + 各类负例均衡 | 人工构造 + 标注 |
| 回归集 | 防止改 prompt / 模型后退化 | 上述两集的固定子集 | 冻结快照 |
| 事件对齐集 | `event_id` 跨批次对齐准确率（insight-analysis AC8） | ≥ 50 组「跨批次同事件」标注 | 人工构造 + 标注 |
| 深挖时延语料 | 主题深挖端到端 P50 时延（report-generation AC3） | 固定 5 主题、约定输入规模 | 真实采集数据，冻结快照 |

评测集随 develop 迭代扩充；更新走 PR 评审。

## 判定阈值（MVP 暂定，M1 末标定）

**上线门槛（DCP-1 硬门槛 / 发布门）：**

| 指标 | 阈值 | 关联 |
|---|---|---|
| 洞察综合评分 | ≥ 70 / 100 | 质量基线 |
| 引用可达性通过率 | 100% | 可溯源底线 |
| 引用一致性合格率 | ≥ 95% | A1 验证 / charter 护栏 |
| 一致性失败率（护栏） | ≤ 5% | charter 反向护栏指标 = `not_support` 占比 |
| flagged 率（第二护栏） | ≤ 10% | 一致性 `uncertain` 占比；防「负例藏进 uncertain」 |
| 展示覆盖 unsafe_accept | = 0 | 手标 display-coverage 反例不得被展示门放行 |
| Coverage quote-self-contained unsafe_accept | = 0 | 独立 coverage 模型仅看 quote+locator 的手标反例不得被放行；不可由主 validator 的先行拒绝掩盖 |
| 幻觉率（人工抽检） | ≤ 2% | charter 反向护栏指标 |
| event_id 跨批次对齐准确率 | ≥ 85% | 不复报机制（在「事件对齐集」上） |

> **2026-05-25 校准（产品负责人定标）**：A1 实跑（见 `a1-runs.md`）显示输出**忠实、可溯源、有用**，
> 但「非显然 / 跨源综合」约占 45%。经判定：本产品的硬质量门是 **可溯源（可达性 100%）+ 低幻觉（≤ 2%）+ 忠实准确** ——
> **忠实的单篇精准转述即属合格洞察**；「非显然 / 跨源综合」由硬门槛降为**追求层**（见下，目标 ≥ 30%、非通过条件）。
> **可达性与幻觉两条红线不松。**

> **2026-06-19 校准（分形态评测 reframe，产品负责人定标 · ADR-0007 B2）**：上表门槛在 **arxiv（书面体）形态**下不变。
> 引入**播客转写（transcript）形态**后，区分两层含义：① 「可达性 100%」红线的本质是**上报引用的可溯源底线**——
> 生产里不可达引用由 validator 判 `blocked`、**结构性不上报**，红线靠 blocking 机制守住；② `run-a1.ts` 量的是
> analyzer **原始**输出可达率（arxiv 干净文本下 ≈ shipped，故历史等价）。transcript 因口语跨段漂移，原始可达 <100%，
> 但残差被 blocked、**上报引用仍 100% 可溯源**。故对 transcript 形态：**原始可达率降为信息量指标（不计 FAIL）**，
> 改以 **yield（=1−blocked 占比，下限暂定 ≥70%、真实跑批后标定）** 作硬门（防"挡到没产出"）；
> **一致性 95% / flagged 10% / 幻觉 2% 三条照旧硬守**。**可溯源与幻觉两条红线仍不松**——只是把"红线"正确锚在
> 上报输出（blocking 守）、而非 analyzer 原始输出。各形态指标按 `stratum` 分组、各比各的已批准基线（`run-a1.ts` / `baseline-registry.json`）。

**质量追求层（非硬门槛，仅跟踪）：**

| 指标 | 目标 | 关联 |
|---|---|---|
| 非显然 / 跨源综合占比 | ≥ 30%（追求，不阻断） | A1「非显然」；越高越好，但单篇忠实复述亦合格 |

**一致性校验器自身准召（citation-validation AC3）：**

| 指标 | 阈值 |
|---|---|
| 一致性判定准确率（support / not_support / uncertain 三分类） | ≥ 90% |
| 对负例（not_support）召回率 | ≥ 95%（宁误杀勿漏网） |

> MVP 只验上述三分类准召；`consistency_reason` 细分类（断章取义 / 夸大 / 张冠李戴）不单独验收，仅供下钻参考。

**洞察一致性（insight-analysis AC6）：**

- 同一输入连续运行 N = 5 次
- 重要性 Top-K（K = 10）洞察集合重合度 ≥ X = 80%
- **引用集合稳定** = 同一洞察各次运行其引用的 `content_item_id` 集合一致（按 ID 集合比对，不比 `quote` / `locator` 的字符级抖动）

**重要性评分（insight-analysis）：**

- 评分尺度 1–5；信号去噪阈值 = 3（< 3 过滤）
- 评分须附 `importance_basis`

**主题深挖端到端时延（report-generation AC3）：**

- 在「深挖时延语料」上连续 N = 10 次
- 端到端起点 = 用户提交深挖请求；终点 = `Report.status` 置 `done`
- P50 ≤ 10 分钟（charter 辅助指标）

**成本（2026-05-27 按 Opus-on-relay 现实重标，provisional）：**

> 重标背景：原 `brief ≤¥0.5 / deep_dive ≤¥3 / initial_digest ≤¥8` 暂定值假设 analyzer=Sonnet；
> 但 MVP 实际经中转站、**只有 Opus**（analyzer 被迫用 Opus-4-6、validator Opus-4-7），且直连 key 目前不可得。
> **口径**：成本 = analyze + validate（report-gen 确定性 $0）；Anthropic 列表价 ×7.2；**validator 带思考**为基准档（安全档，A1 验证用）；含 ~1.5× 余量。
> **实测锚点**：brief 的 analyze（6 条 arXiv · opus-4-6）= $0.073 ≈ **¥0.53**；validate 随引用数变化，带思考约 ¥0.2–0.35/引用。

- 单份报告平均成本（按 `Report.type`，Opus-on-relay 带思考基准）：`brief` ≤ **¥5**；`deep_dive` ≤ **¥15**；`initial_digest` ≤ **¥30**（冷启动回填全量历史，放宽）
  - 注：validator **thinking-off 约减半**（A1 显示带思考仅边际提精度、负例召回 98.3%→100%，可视成本权衡取舍）；
  - 注：将来取得**直连 key + analyzer 切 Sonnet** 可大幅降本，届时按干净测量收紧本阈值。
- 单条引用一致性校验 ≤ 4000 token
- 人工抽检比例：一致性校验结果抽检 10%

**回归告警：** 任一上线门槛指标较基线下降 > 3 个百分点即告警，阻断合并。

### 基线可比性与诊断证据

基线只对**同一评测配置**有效。`EvalConfig` 必须记录分析/校验/Coverage 模型、两角色 thinking 的有效值及来源、
thinking transport 版本、批量判定开关、展示覆盖主审计的输出预算和每请求 atomic-claim 数、各数据集与 `dataset-lock` SHA-256。任一项变化后，脚本只展示旧指标，
不得把它当作回归结论。历史 `baseline.json` 没有完整配置与 v2 lock，登记为 `legacy`，明确不可比。

新的可比基线走 `evals/baseline-registry.json` 的两次运行状态机：同一 clean commit、同一 stratum、相同
EvalConfig 和受控 v2 数据锁的首个完整 automatic pass 只能是 `provisional`；第二个不同 run_id 的同条件完整
automatic pass 才可标为 `dcp_accepted`。dirty、smoke、失败/不完整、缺 lock、artifact hash 失配或配置漂移一律
拒绝提升。`dcp_accepted` 仍不是人类 DCP 签字。

正式回归门**只**消费 `dcp_accepted` registry，且该记录必须覆盖当前形态的全部规范指标键；缺任一键、零个完成形态、
或任何配置不符均为 `incomparable` 并以非零退出。`baseline.json` 只保留历史诊断，不能让正式门放行。自动阈值 `pass`
仍可作为两次提升状态机的候选，但不等于 Eval-Gate 通过。

`consistency_ok` / `consistency_failure` 衡量的是 analyzer 原始输出中「完整 statement × 单个来源」的判定结果；它既反映过度声称，也会受多源复合结论的逐来源严格判定影响，不能单独等同于已发布报告的幻觉率。发布安全仍以白名单后的引用可达性和人工幻觉抽检为准；校验器能力应同时查看三分类混淆矩阵、各类 precision/recall 与负例召回。

每次真模型运行都应保留 `evals/out/runs/<run-id>/a1-run.json`：包含配置、逐主题 CitationCheck、逐标注对预测/rationale、混淆矩阵、逐候选展示覆盖终态、主 AND 门和 quote-only Coverage 基准结果，以及按 role 的 calls/requests/failures/P95 和输出 stop-reason 计数（例如 `max_tokens`）。`manifest.json` 的 `llm_role_telemetry.by_operation` 还必须按代码固定调用阶段拆分这些计数，以区分一致性批判定、展示主审和 quote-only 复核；任何未标记调用必须显式为 `unclassified`，不能把截断静默归入另一个阶段。`manifest.json` 记录输入/源码指纹、洞察 ID 集合 digest 和 artifact hashes。长主题的失败 run 另带哈希绑定的本地 `quality-checkpoint.json`：只含已完成 analyzer 分块的后审计模型结果，恢复时仍须重新验证输入/配置绑定；它不是 partial pass。运行目录先在临时位置完整写入后才原子发布；`latest-complete.json` 只指向最近**完成**运行，绝不表示质量或 DCP 通过。

### A1 运行效率与证据边界

- 开发中的真模型连通性、结构化输出和成本检查使用 `npm run eval:a1:smoke`。该入口固定缩小四类样本并写入 `A1_FORCE_SMOKE=1`，即使自定义 fixture 恰好没有被截断也仍是 `smoke`；它只能用于排障和成本标定，不能用于 DCP、baseline、Eval-Gate 或发布结论。
- 正式全量运行不使用任何 `A1_*_LIMIT`，并保持所有模型、prompt、Thinking、batch 和数据锁配置不变。默认单主题截止为 30 分钟：它只减少合法长尾被迫重跑的概率，不改变评分口径；45 分钟仍是硬上限。
- 单条标注集一致性判定默认有 5 分钟的**全重试树**截止（`A1_JUDGE_TIMEOUT_MS`，可在 30 秒至 10 分钟间显式设置）：它覆盖 SDK 和应用层重试，避免一次持续的传输失败累加成十余分钟长尾。超时会传递取消信号、记录用例序号与总耗时，并使核心评测不完整；不得将它改标为 `support`、`uncertain` 或任何可计分预测。该设置是失败关闭的执行保障，不改变成功判定的语义或基线评分口径。
- 独立的展示/quote Coverage 基准同样有默认 5 分钟的全重试树截止（`A1_COVERAGE_TIMEOUT_MS`，范围相同）。生产门对不可用的 Coverage 仍保守拒绝展示；但评测不得把这种“因基础设施失败而拒绝”当成手标反例被正确拒绝。它会记录 case ID、总耗时和无敏感错误类别，并将自动门置为 `not_evaluated`。
- 若全量运行在 quality 阶段失败，可使用其 hash 绑定的 `A1_RESUME_FROM` 恢复连续完整的 analyzer 分块。恢复必须匹配完整 EvalConfig、质量数据集、topic/case 顺序及分块输入哈希；它用于失败恢复，不替代两次独立的 clean full-run baseline 证据。
- 每次全量或 smoke 都应先查看按 `role → by_operation` 写入的 calls、failures 与 P95。只有确认长尾来自彼此独立的 judge/benchmark 调用后，才可以用显式、受测且进入 EvalConfig 的 `A1_INDEPENDENT_CALL_CONCURRENCY` 做单独性能实验：默认 `1`，目前仅允许 `2`；不得并行化长正文 analyzer 或在未测 relay 容量时提高并发。`2` 的 smoke canary 和全量实验均与串行基线不可比，只有质量和可靠性均无回退后才能另建同配置 baseline。

人工结论通过 verifier-backed 的**加性** `review-receipt.json` 绑定 run_id、manifest/queue/dataset-lock hash、全量 reader-visible insight ID 和文本 hash。两位 reviewer 必须对每条作独立盲评；所有分歧必须由不同的第三人 adjudicate。receipt 即使成功也只写 `eligible_for_signoff`。n=50、至多 1 条幻觉只是观测样本率 ≤2%，不是总体保证；非显然（目标 ≥30%）及 importance 合理性均为诊断，不是 receipt 的自动 DCP 阈值。

## 评测流程

1. **自动评测** —— 每次改 prompt / 模型 / 数据源的 PR，CI 跑回归集，输出各指标 + 与基线对比，附在 PR（见 `skills/L3-quality.md`）。
2. **人工抽检** —— 一致性校验结果按 10% 抽检，作为护栏指标真值来源；抽检发现的错误回流校准阈值。
3. **A1 验证（DCP-1）** —— M1 内在洞察质量集上完整跑一遍上线门槛指标，结果作为 DCP-1 评审材料。
4. **基线管理** —— 每次 DCP / 发布门通过时，冻结当前指标为新基线。
