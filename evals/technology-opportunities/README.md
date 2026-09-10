# 技术机会映射 Dogfood 协议 v2

本协议评测“已校验 TechLead → 候选 / 方向 / 通道”的**确定性**投影，不评估事实真伪；事实可追溯性仍由 A1 引用评测覆盖。它不改词表、不会创建机会、不会自动立项，也不引入语义映射。

## 盲标与固定样本

1. 从只读快照导出**全量合格 TechLead**（即仍有当前 `pass` 证据、未 dismissed 的 `listPlanningTechLeads` 语义），绝不能从 `TechnologyOpportunity` pool 倒推样本。
2. 在隔离目录运行：

   ```bash
   npx tsx evals/build-opportunity-dogfood-v2-sample.ts qualified-leads.json blind-manifest.json <fixed-seed> 20
   ```

   输入是 `{ "snapshot_at": "<ISO UTC>", "leads": [...] }`；输出以 `wx` 创建，避免静默覆盖。清单记录 UTC 时间、总体规模、固定 seed、总体摘要和分层抽样方法；每行只含不敏感的 sample id、topic、kind、证据/新鲜度分桶，不含 TechLead id、标题、quote、URL 或系统映射结果。
3. 评审者先依据允许的证据填写 `labels.v2.template.json` 的 `expected_*` 字段。`actual_*` 必须在盲标封存后才回填。`not_enough_evidence=true` 会从所有评分分母剔除；`expected_candidate=false` 必须有 `exclusion_reason`。
4. 运行：

   ```bash
   npm run eval:opportunity-map -- labels.v2.json
   ```

   输出 candidate precision/recall、按 topic/kind/期望 lane 的覆盖、candidate/direction/lane 混淆矩阵，以及带 sample id 的错分归因。

## 20 条 pilot

`pilot-v2.blind-manifest.json` 与 `pilot-v2.labels.json` 是固定、脱敏的 20 行**协议可用性 fixture**：它覆盖候选、排除、horizon、错 lane / 错 direction、漏候选和 `not_enough_evidence` 的数据契约。它不是生产快照，不表达映射质量，也不能满足原先 50–100 条的质量收口条件。

标签不得包含原文全文、密钥或生产个人数据。实际 dogfood 样本的证据仍通过 TechLead 的 `pass` 引用链复核；仅在人工复核后才可讨论显式词项调整，不能以语义映射、自动立项或生产写入替代复核。
