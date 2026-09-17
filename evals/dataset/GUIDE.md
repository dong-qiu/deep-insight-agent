# A1 评测集构建指南

把种子样本换成**真实、有标注**的数据，是 A1 实跑出可信结论的前提。本文给团队一个可执行的填充流程。

## 目标规模（来自 `docs/verify/eval-criteria.md`）

| 数据集 | 文件 | 规模下限 | 用途 |
|---|---|---|---|
| 洞察质量集 | `insight-quality.jsonl` | **≥ 5 个唯一主题，且最终 `reader_visible_by_topic` 每个 `topic_id` ≥ 10 条**（经 v6 audit 与 pass/support 白名单筛选后） | 算可达性/一致性/flagged + 人评非显然&幻觉 |
| 引用一致性集 | `citation-consistency.jsonl` | **≥ 100 组**引用-结论对，正负例均衡（负例覆盖 3 类） | 算校验器三分类准确率 + 负例召回率 |

低于此规模，`run-a1` 会打 ⚠️ 提示，结论**不作 DCP 判定依据**。以运行产物 `manifest.json` 的 `dcp_sample.reader_visible_by_topic` 为准，不能用输入条目数或 analyzer 原始输出替代。

## 数据从哪来

用 `docs/plan/source-feasibility.md` 的 **MVP 接入清单（22 feeds）** 里的真实内容，别造假数据。建议覆盖面：

- 至少 5 个**真实订阅主题**（如 Code Agent、Prompt Injection 防御、RAG、Agent 评测、AI 编程工程化…）
- 每主题取**近 2–3 周、跨 ≥ 3 个不同来源**的真实条目（web/news + arXiv + 社交/视频字幕混合，贴近真实噪音）
- 含"无重要事件"的窗口若干，验证诚实兜底

## 格式

### `insight-quality.jsonl`（每行一个主题窗口）

```json
{"topic":{"id":"t_xxx","name":"主题名","keywords":["kw1","kw2"],"language":"zh"},
 "time_window":{"start":"2026-05-01","end":"2026-05-21"},
 "items":[{"id":"ci_1","source_id":"arxiv","url":"...","title":"...","published_at":"2026-05-12","language":"en","topic_ids":["t_xxx"],"body":"真实正文（保留原文，校验靠逐字匹配 quote）"}]}
```

> `body` 必须是**真实原文**：analyzer 的 quote 要逐字摘自它，validator 的可达性校验做归一化子串匹配。改写 body 会让可达性误判。

### `citation-consistency.jsonl`（每行一组标注对）

```json
{"statement":"待校验的结论","source_text":"被引原文片段","expected_consistency":"support|not_support|uncertain","negative_type":"out_of_context|exaggeration|misattribution"}
```

`negative_type` 仅在 `not_support` 时填，且**仅作分析归类**——脚本评分只看三分类 `expected_consistency`（MVP 不验 reason 细分类，见 eval-criteria）。

## 引用一致性的标注规则

判断标准：**「这段原文是否真的支持这个结论」**，而非结论本身对不对。

| 标签 | 含义 | 例 |
|---|---|---|
| `support` | 原文明确支持，无歪曲 | 原文"回归率降了 38%" → 结论"降低了回归率" |
| `not_support` / **exaggeration**（夸大） | 把程度/范围放大 | 原文"降了 38%" → 结论"**消除了所有**回归" |
| `not_support` / **out_of_context**（断章取义） | 忽略原文已有的限定/反例，导致含义冲突 | 原文"门控更优，**但 flaky 测试会误删正确补丁**" → 结论"门控在**所有场景**都更优" |
| `not_support` / **misattribution**（张冠李戴） | 主体/对象错配 | 原文"**prompt injection** 是头号风险" → 结论"**供应链**是头号风险" |
| `uncertain` | 原文对关键主体、数值、比较、范围或条件没有足够信息，既不能证实也不能反驳 | 原文只说"易受注入" → 结论"**主要影响金融行业**" |

标注要点：
- **宁误杀勿漏网**：拿不准 support 就别标 support（与 validator 的判定倾向一致）。
- **“原文沉默”不是负例**：原文仅未提及某主体、数值、比较、范围或条件时标 `uncertain`；只有原文与 claim 有可判定冲突，或 claim 曲解原文已有事实时才标 `not_support`。这一区分决定 `uncertain` 的人工核实与 `not_support` 的阻断处置，不能混用。
- 负例要覆盖 3 类，且数量足够算召回（建议负例 ≥ 40 条）。
- 每条对最好独立可判（`source_text` 自带足够上下文）。

## 产出 checklist

- [ ] 最终运行产物：≥ 5 个唯一主题，`dcp_sample.reader_visible_by_topic` 中每个主题 ≥ 10 条 reader-visible 洞察；输入内容真实跨源，含 ≥ 1 个"无事件"窗口
- [ ] `citation-consistency.jsonl`：≥ 100 组，正负均衡，负例覆盖 3 类（≥ 40 条负例）；受控 v2 版本还须有稳定 `id`
- [ ] 两份文件均为合法 JSONL（每行可独立 `JSON.parse`）
- [ ] `body` / `source_text` 为真实原文，未改写
- [ ] 标注由**非生成者**完成（避免与 analyzer 同源偏差），最好双人交叉
- [ ] 受控 v2 标签：两位独立 human reviewer 对同一 `id + statement + source_text` hash population 盲标；只把分歧交给第三位 human 裁决。用 `npm run labels:receipt -- <citation-consistency-v2.local.jsonl> <blind-labels.json> [receipt.json]` 生成无正文的 receipt；它会拒绝 AI reviewer、同一 reviewer、漏标、未裁决的分歧、最终 JSONL 与裁决不一致、少于 100 对、少于 40 个 `not_support` 或缺少任一负例类型，并记录两位 human blind-attestation/提交 hash 与必要的裁决人 provenance。`consistency-human-labels.template.json` 只示意提交结构；实际提交和 receipt 留在受控存储。v2 `dataset-lock` 除绑定不可变 receipt 引用和 SHA-256 外，运行时还必须以 `A1_CONSISTENCY_RECEIPT_FILE` 注入该 receipt 的受控本地副本；验证器会核验其 bytes、状态、JSONL binding 和 human provenance，不能只写“已双标”。
- [ ] 可先运行 `npm run labels:prepare-candidates -- <quality-v2.local.jsonl> <candidates.local.jsonl>`：它从每条受控原文提取一个未定标签 pair，并把模型、prompt、planned mix 另存为 `diagnostic_only` manifest。候选 JSONL 不含预期标签；只把它交给两位盲标 human，**绝不**把相邻 diagnostic manifest 交给他们。human 裁决后的最终文件才可成为 `citation-consistency-v2.local.jsonl` 并进入 receipt。
- [ ] 在分发前运行 `npm run labels:prepare-blind-worklist -- <candidates.local.jsonl> <worklist.local.jsonl>`：它剔除生成器元数据，仅保留 `id`、statement、source_text 与 receipt 所需的 `pair_sha256`。同一个受控 worklist 可分别提供给两位 human；任何带标签、intent 或 rationale 的输入都会被拒绝。
- [ ] 若以表格完成盲标，分别运行 `npm run labels:prepare-csv -- <worklist.local.jsonl> <reviewer-a.local.csv>` 与 reviewer B 版本。CSV 会保护以公式前缀开头的第三方文本，且只留下两列可填写：`expected_consistency`、`negative_type`。每位 human 完成后，独立运行 `npm run labels:csv-to-submission -- <worklist.local.jsonl> <filled.local.csv> <opaque-human-id> <submission.local.json>`；转换器会拒绝漏标、标签/type 不匹配、pair hash 不匹配或 statement/source_text 被改动的表格。
- [ ] 原型可选 AI-assisted 入口：对同一 worklist 依次运行 `npm run labels:ai-review -- <worklist.local.jsonl> validator <validator.local.json>` 与 `... coverage <coverage.local.json>`；它会使用当前两个不同模型（并记录 Thinking/prompt/输入 hash）。再运行 `npm run labels:ai-compare -- <worklist> <validator> <coverage> <disputes.local.jsonl> <receipt.local.json>`。human 只接收 `disputes.local.jsonl` 派生的 `npm run labels:ai-dispute-csv` 表格，绝不接收 AI 标签。裁决后使用 `labels:ai-dispute-to-adjudication` 和 `labels:ai-finalize` 生成暂定 JSONL。该 receipt 的 `lock_eligible=false`，不能代替上面的双 human receipt。
- [ ] 跑 `npm run eval:a1`，⚠️ 规模提示消失，自动门槛全 PASS
- [ ] 不把仓内 legacy fixture 升为 DCP baseline。v2 数据必须放在受控不可变快照；`dataset-lock` 必须绑定输入哈希、source URL/ID manifest、采集时间、topic 映射、去重规则、标签分布，以及 `object_lock_retain_until` 和受控 `source_terms_decision`（owner record ID、SHA-256、`approved_all`、批准时间、许可保留截止）。许可保留截止不得早于 Object Lock 截止；而不是提交新的第三方全文。
- [ ] AI 预标注（可选）：使用 `ai-prelabel-handoff.template.json` 记录三个 `diagnostic_only` 预标注者的模型、Thinking、prompt 和产物 hash；不能将标签、理由或文件交给盲评 reviewer，也不能作为 `review:receipt` 输入。
- [ ] 人评：两位独立盲评必须逐条覆盖同一 reader-visible population；`npm run review:csv` 会拒绝任何 AI 预标注参数。待两份人工提交冻结后，才可揭示预标注作诊断。对人工分歧由第三位**人工** adjudicate，再运行 `npm run review:receipt -- <manifest.json> <review-queue.json> <blind-reviews.json>`；submission 必须声明 `reviewer_kind: "human"`，adjudication 必须声明 `adjudicator_kind: "human"`。该 receipt 最多产生 `eligible_for_signoff`，不替代 DCP owner/architect 签署。n=50 时最多 1 条幻觉是样本点估计 ≤2%，并非总体保证；非显然与 importance 合理性记录为诊断指标（当前无 DCP 自动阈值）。

## 本仓自带数据集的来源与已知局限

当前 `dataset/*.jsonl` 不是占位种子，是 2026-05-24 实抓构建的：

- **`insight-quality.jsonl`**：5 主题 × 6 篇 = 30 条，全部为 **arXiv（2026-05）真实论文摘要**（经 arXiv API 抓取，轻清洗 LaTeX 符号）。
  - ⚠️ **单一来源（全是 arXiv）**：未覆盖 news / 社交 / 视频字幕等异构噪音。团队应按上文从 `source-feasibility.md` 的非学术源补充，才能真正压测"多源去噪"。
  - RAG 主题里混入了 1 篇天文学论文（真实搜索噪音），有意保留以测试主题去噪。
- **`citation-consistency.jsonl`**：120 组。`source_text` 为上述摘要的**逐字片段**；`statement` 由 AI **按类型构造**（label-by-construction：故意写成夸大/断章取义/张冠李戴/不确定）。
  - ⚠️ **标签是 AI 构造的，未经人工校验**。构造型负例的标签由构造保证、相对可靠，但 support / uncertain 的边界仍需**人工抽查**（见上"标注由非生成者完成"）。作 DCP 判定前请抽查 ≥ 20% 并修正。
