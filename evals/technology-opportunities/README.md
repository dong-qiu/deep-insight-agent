# 技术机会映射 Dogfood 协议 v2

本协议评测“已校验 TechLead → 候选 / 方向 / 通道”的**确定性**投影，不评估事实真伪；事实可追溯性仍由 A1 引用评测覆盖。它不改词表、不会创建机会、不会自动立项，也不引入语义映射。

## 盲标与固定样本

1. 从只读快照导出**全量合格 TechLead**（即仍有当前 `pass` 证据、未 dismissed 的 `listPlanningTechLeads` 语义），绝不能从 `TechnologyOpportunity` pool 倒推样本。唯一可执行输入是 `qualified-tech-leads-snapshot-v2`，明确声明 `source=listPlanningTechLeads`、`qualification=current_pass_evidence_and_not_dismissed`、`pagination=unbounded`、`total_count`，并逐行带 `status`、`pass_evidence_count` 和确定性映射输入；500 行默认 view、截断、dismissed 或无 pass 的快照会被拒绝。v1 是历史格式，不可执行。
2. 在隔离目录先运行 `npm run eval:opportunity-export -- qualified-snapshot.json <UTC>`，再运行：

   ```bash
   npm run eval:opportunity-sample -- qualified-snapshot.json blind-manifest.json <fixed-seed> 20
   ```

   快照还私有地保存确定性投影所需的 lead 输入和方向词表；blind manifest 不含 TechLead id、标题、quote、URL 或 actual。所有文件以 `wx` 创建，避免静默覆盖。`pilot` 仅可显式传入第 5 个参数 `true`，并且不可评分；20 条真实 dogfood 默认仍可评分。
3. Owner 在封存前可从同一份离线快照、blind manifest 和固定 seed 创建私有、只读的 review-pack：

   ```bash
   npm run eval:opportunity-review-pack -- qualified-snapshot.json blind-manifest.json <fixed-seed> owner-review-pack.json
   ```

   该工件逐条给出 `sample_id`、稳定 `lead_id`、topic、kind、标题、摘要和证据计数，并只列出可选的 `direction_id`。Owner 使用既有管理界面按 `lead_id` 复核 `pass` 证据；工件不含方向词项或投影结果。仅向 Owner 交付，不能提交到 Git。封存 expected-only 文件前不得运行映射导出；review-pack 不是评分输入，也不会读取数据库或其他环境。
4. 评审者先依据允许的证据填写只含 expected 字段的私有文件，并封存：`npm run eval:opportunity-seal -- blind-manifest.json expected-only.json sealed.json <UTC>`。封存 schema 严格 expected-only，拒绝任何结果映射字段。之后从**同一 snapshot**只读导出确定性映射：`npm run eval:opportunity-mapping-export -- qualified-snapshot.json deterministic-mapping.json`，再运行 `npm run eval:opportunity-materialize -- qualified-snapshot.json blind-manifest.json sealed.json deterministic-mapping.json labels.json <UTC>`。不接受自由 lead-id→映射结果输入。
5. 评分必须同时提供同一 snapshot、manifest、seal 和 deterministic mapping：

   ```bash
   npm run eval:opportunity-map -- labels.json qualified-snapshot.json blind-manifest.json sealed.json deterministic-mapping.json
   ```

   输出 candidate precision/recall、按 topic/kind/期望 lane 的覆盖、candidate/direction/lane 混淆矩阵，以及带 sample id 的错分归因。

## 20 条 pilot

历史 `pilot-v2.*` 是固定、脱敏的协议 fixture，明确**不可评分、不可执行**；它没有 v2 snapshot/seal/mapping bind，不能作为 dogfood 或质量证据。

标签不得包含原文全文、密钥或生产个人数据。实际 dogfood 样本的证据仍通过 TechLead 的 `pass` 引用链复核；仅在人工复核后才可讨论显式词项调整，不能以语义映射、自动立项或生产写入替代复核。
