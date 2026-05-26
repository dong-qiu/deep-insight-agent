# M2 后端端到端集成验证

## 2026-05-26 · 后端四 agent 管线端到端跑通（真模型 + 真持久化）

首次以**真模型 + 真 SQLite/FS** 跑完整条后端脊柱（此前各块仅单测、未串跑）：

```
seed 主题/源 → collectSource(HN 真实采集入库) → runAnalysis → runValidation → runReportGen
            （各包一条 Run；产出落 SQLite + 报告正文落 FS + FTS5）
```

**结果（全通）**
- ingest / analyze / validate / report-gen **四条 Run 全 done**；analyze 计费 **$0.037 / 6292 tok**（opus-4-6）。
- `getReport` 从 FS 读回正文；`searchReports` FTS 命中该报告；Run 成本记账正常。
- 每处拼接均验证：分析产出落库（topic 外键）、校验按 id 反查 ContentItem、report-gen 反查 source/tags、FS 正文读回、FTS 检索。

**正确的边界行为（非 bug）**
- 本轮 analyzer 仅产 1 条且触发截断 → **产出守卫丢弃** → 0 洞察 → 走「无重要事件」报告路径（`releasable=true`、`status=done` 而非 failed），符合 architecture 诚实兜底契约。
- 截断问题复现（守卫挡住半句污染）—— 治本（streaming / 自由文本输出）属评审 round2。

**结论**：M2 后端是**真连通**的，不只是单测绿。配置 opus-4-6 / opus-4-7、thinking off（中转站约束）。
内容向「有洞察」的运行需聚焦 arXiv 源 + 对口主题（arXiv 未被 429 时）。
