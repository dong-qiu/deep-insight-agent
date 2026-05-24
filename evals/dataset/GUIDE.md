# A1 评测集构建指南

把种子样本换成**真实、有标注**的数据，是 A1 实跑出可信结论的前提。本文给团队一个可执行的填充流程。

## 目标规模（来自 `docs/verify/eval-criteria.md`）

| 数据集 | 文件 | 规模下限 | 用途 |
|---|---|---|---|
| 洞察质量集 | `insight-quality.jsonl` | **≥ 5 主题 × ≥ 10 条洞察**（即每主题喂够能产 ~10 洞察的真实内容） | 算可达性/一致性/flagged + 人评非显然&幻觉 |
| 引用一致性集 | `citation-consistency.jsonl` | **≥ 100 组**引用-结论对，正负例均衡（负例覆盖 3 类） | 算校验器三分类准确率 + 负例召回率 |

低于此规模，`run-a1` 会打 ⚠️ 提示，结论**不作 DCP 判定依据**。

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
| `not_support` / **out_of_context**（断章取义） | 忽略限定/反例，过度概括 | 原文"门控更优，**但 flaky 测试会误删正确补丁**" → 结论"门控在**所有场景**都更优" |
| `not_support` / **misattribution**（张冠李戴） | 主体/对象错配 | 原文"**prompt injection** 是头号风险" → 结论"**供应链**是头号风险" |
| `uncertain` | 原文信息不足以判断 | 原文只说"易受注入" → 结论"**主要影响金融行业**" |

标注要点：
- **宁误杀勿漏网**：拿不准 support 就别标 support（与 validator 的判定倾向一致）。
- 负例要覆盖 3 类，且数量足够算召回（建议负例 ≥ 40 条）。
- 每条对最好独立可判（`source_text` 自带足够上下文）。

## 产出 checklist

- [ ] `insight-quality.jsonl`：≥ 5 主题，真实跨源内容，含 ≥ 1 个"无事件"窗口
- [ ] `citation-consistency.jsonl`：≥ 100 组，正负均衡，负例覆盖 3 类（≥ 40 条负例）
- [ ] 两份文件均为合法 JSONL（每行可独立 `JSON.parse`）
- [ ] `body` / `source_text` 为真实原文，未改写
- [ ] 标注由**非生成者**完成（避免与 analyzer 同源偏差），最好双人交叉
- [ ] 跑 `npm run eval:a1`，⚠️ 规模提示消失，自动门槛全 PASS
- [ ] 人评 `evals/out/review-queue.json`：非显然占比 ≥ 60% / 幻觉率 ≤ 2%

## 本仓自带数据集的来源与已知局限

当前 `dataset/*.jsonl` 不是占位种子，是 2026-05-24 实抓构建的：

- **`insight-quality.jsonl`**：5 主题 × 6 篇 = 30 条，全部为 **arXiv（2026-05）真实论文摘要**（经 arXiv API 抓取，轻清洗 LaTeX 符号）。
  - ⚠️ **单一来源（全是 arXiv）**：未覆盖 news / 社交 / 视频字幕等异构噪音。团队应按上文从 `source-feasibility.md` 的非学术源补充，才能真正压测"多源去噪"。
  - RAG 主题里混入了 1 篇天文学论文（真实搜索噪音），有意保留以测试主题去噪。
- **`citation-consistency.jsonl`**：120 组。`source_text` 为上述摘要的**逐字片段**；`statement` 由 AI **按类型构造**（label-by-construction：故意写成夸大/断章取义/张冠李戴/不确定）。
  - ⚠️ **标签是 AI 构造的，未经人工校验**。构造型负例的标签由构造保证、相对可靠，但 support / uncertain 的边界仍需**人工抽查**（见上"标注由非生成者完成"）。作 DCP 判定前请抽查 ≥ 20% 并修正。
