# A1 验证切片 (evals)

> 验证 charter 关键假设 **A1**：「LLM 能否从多源噪音中可靠提炼出非显然、可溯源、低幻觉的洞察」。
> 对应 `insight-analysis` AC10、`citation-validation` AC3，是 **DCP-1 → M2 的硬门槛**。

这是一把"尺子"，不是骨架 —— 用最薄的端到端切片（ContentItem → analyzer → validator → 指标）
先证伪 A1，再决定是否投入完整骨架（采集 / 持久化 / UI / 调度等）。

## 跑之前

1. **Node 20+**，安装依赖：`npm install`
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
| 校验器三分类准确率 / 负例召回率 | 标注集 `citation-consistency.jsonl` | 自动 |
| 非显然洞察占比、幻觉率 | 需人评 → 脚本导出 `out/review-queue.json` | 人工 |

阈值镜像自 `docs/verify/eval-criteria.md`「上线门槛」（改阈值请同步那份文档）。
自动门槛全过 → 退出码 0；有 FAIL → 退出码 1（便于 CI 门禁）。

## 数据集

- `dataset/insight-quality.jsonl` —— 每行 `{topic, items, time_window}`，喂给 analyzer。
- `dataset/citation-consistency.jsonl` —— 每行 `{statement, source_text, expected_consistency, negative_type?}`，标注集。

⚠️ **当前是 2 个主题 + 5 组标注的种子样本，仅够验证管线打通。**
作 DCP 判定前须扩到 eval-criteria 规模：**≥ 5 主题 × ≥ 10 洞察、≥ 100 组引用-结论对**，
且用 `source-feasibility.md` MVP 清单里的**真实采集内容**（种子样本是示意，非真实数据）。

## 模型

默认 分析=`claude-sonnet-4-6` / 校验=`claude-opus-4-7`（架构选型；校验模型必须独立于分析模型，
否则启动即报错）。可用 `ANALYZER_MODEL` / `VALIDATOR_MODEL` 环境变量覆盖。

## 不在本切片范围

采集 / `lib/sources` / 持久化(SQLite) / Job Runner / UI / Docker / cron / 跨批次 `event_id` 对齐 ——
全部待 A1 通过后建骨架时实现（见 `docs/plan/architecture.md`）。
