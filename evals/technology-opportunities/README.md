# 技术机会映射 Dogfood 协议 v2

本协议评测“已校验 TechLead → 候选 / 方向 / 通道”的**确定性**投影，不评估事实真伪；事实可追溯性仍由 A1 引用评测覆盖。它不改词表、不会创建机会、不会自动立项，也不引入语义映射。

## 盲标与固定样本

1. 从只读快照导出**全量合格 TechLead**（即仍有当前 `pass` 证据、未 dismissed 的 `listPlanningTechLeads` 语义），绝不能从 `TechnologyOpportunity` pool 倒推样本。输入必须是 `qualified-tech-leads-snapshot-v1`，明确声明 `source=listPlanningTechLeads`、`qualification=current_pass_evidence_and_not_dismissed`、`pagination=unbounded`、`total_count`，并逐行带 `status` 与 `pass_evidence_count`；500 行默认 view、截断、dismissed 或无 pass 的快照会被拒绝。
2. 在隔离目录先运行 `npm run eval:opportunity-export -- qualified-snapshot.json <UTC>`，再运行：

   ```bash
   npx tsx evals/build-opportunity-dogfood-v2-sample.ts qualified-leads.json blind-manifest.json <fixed-seed> 20
   ```

   输入是 `{ "snapshot_at": "<ISO UTC>", "leads": [...] }`；输出以 `wx` 创建，避免静默覆盖。清单记录 UTC 时间、总体规模、固定 seed、总体摘要和分层抽样方法；每行只含不敏感的 sample id、topic、kind、证据/新鲜度分桶，不含 TechLead id、标题、quote、URL 或系统映射结果。
3. 评审者先依据允许的证据填写只含 expected 字段的私有文件，并封存：`npm run eval:opportunity-seal -- blind-manifest.json expected-only.json sealed.json <UTC>`。sealed artifact 不含 lead id 或 actual。随后才用**同一 snapshot**及私有 lead-id→actual mapping 运行 `npm run eval:opportunity-materialize -- qualified-snapshot.json blind-manifest.json sealed.json actual-by-lead-id.json labels.json <UTC>`；任意 manifest 行重排、换 strata、改 expected、错快照或 actual 泄漏都会失败。
4. 运行（labels 的同目录需有对应 blind manifest，或显式作为第二参数）：

   ```bash
   npm run eval:opportunity-map -- labels.v2.json
   ```

   输出 candidate precision/recall、按 topic/kind/期望 lane 的覆盖、candidate/direction/lane 混淆矩阵，以及带 sample id 的错分归因。

## 20 条 pilot

`pilot-v2.blind-manifest.json` 与 `pilot-v2.labels.json` 是固定、脱敏的 20 行**协议可用性 fixture**：它覆盖候选、排除、horizon、错 lane / 错 direction、漏候选和 `not_enough_evidence` 的数据契约。它不是生产快照，不表达映射质量，也不能满足原先 50–100 条的质量收口条件。

标签不得包含原文全文、密钥或生产个人数据。实际 dogfood 样本的证据仍通过 TechLead 的 `pass` 引用链复核；仅在人工复核后才可讨论显式词项调整，不能以语义映射、自动立项或生产写入替代复核。
