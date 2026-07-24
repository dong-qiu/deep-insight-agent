# 技术机会映射评测

本评测衡量“已校验技术线索 → 方向 / 通道”的确定性投影，不评估事实真伪；事实可追溯性仍由 A1 引用评测覆盖。

1. 从生产快照或隔离 seed 取 50–100 条已有 `pass` 证据的 TechLead，覆盖三个主题及 core / adjacent / horizon / challenge。
2. 由未编写映射规则的评审者填写 `labels.template.json`：只按方向档案判断期望 `direction_id` 和 `lane`。方向不适用时应标 `null` + `horizon`。
3. 将映射器输出回填为 `actual_*`，运行：`npx tsx evals/score-opportunity-map.ts <labels.json>`。
4. 在引入语义模型、自动聚类或修改词表前，先记录 lane / direction / exact accuracy；低于人工复核认可阈值时只调整词表或保留人工处理，不能以自动立项兜底。

标签不得包含原文全文、密钥或生产个人数据。样本的真实证据仍通过 `GET /api/opportunities/:id` 返回的 TechLead pass 引用链复核。
