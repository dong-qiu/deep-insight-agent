# Daily Brief 单主题首发：生产路径回归矩阵

> 2026-10-03 · S0 测试设计，状态为**待实现**。依赖[成员发布契约](../plan/specs/daily-brief-density-member-publication-contract.md)与[加速交付切片](../plan/specs/daily-brief-density-fast-release.md)。旧模式 4 个相关测试文件 189/189 通过、只读导出器 15/15 通过，只作为 before 基线。

## 隔离与验证范围

所有新格式用例使用隔离 SQLite、临时 artifact 目录和禁用通知的环境，优先调用实际 `runReportGen`、`saveReport`、两种 reconcile 与生产读取函数。纯选择器单测只能补充定位，不能代替提交与恢复证明。一个测试不能只检查“抛错”，还要确认 `done`、index/FTS、artifact 可见性、通知及后续重试状态。

## 场景矩阵

| 阶段 | 场景与注入点 | 必须观察到的结果 | 主要测试落点 |
|---|---|---|---|
| S2 | 试点开关 off，旧 batch 包含同事件多条候选 | 选择顺序、引用、decision reason 与现版一致；非试点 topic、deep dive、initial digest 不变 | `report-gen.test.ts`、`pipeline-reportgen.integration.test.ts` |
| S2 | 新格式每成员分别有 `kept`/`kept_degraded` 展示审计和 `pass/support`；再逐一改成缺审计、flagged、blocked、`not_support` | 仅全部成员合格时成组；任何不合格成员不能借另一成员引用发布；拒绝原因保留在候选级 | `report-gen.test.ts`、`report-review.test.ts`、pipeline 集成 |
| S2 | `kept_degraded` 成员没有获准的中文 `reader_statement`；另测有 hash 绑定的中文结论 | 前者只展示已审 source-quote 投影，后者只展示精确绑定的结论；两者的最终文本/hash、quote/locator 与引用编号均进入同一 guard | `report-gen.test.ts`、`reader-evidence.test.ts`、pipeline 集成 |
| S2 | quote locator 错位、来源 revision 改变、raw archive 缺失/字节 hash 或 envelope 不符 | 意图前或发布 guard 拦截；不能以 URL 可达、当前正文子串或另一版本归档过关 | `reports.test.ts`、`reader-evidence.test.ts`、pipeline 集成 |
| S2 | 同 URL 多事件、同实体不同产品/版本、同研究不同 `event_id`、相同 `event_id` 不同事件 | 正确归组或保守退回；不把事件 ID/URL/实体单独当归组证明 | `report-gen.test.ts` 加人工标注反例 |
| S2 | 历史同命题跨来源重述、旧报告缺新身份、近 14 天窗口边界、on→off→on | 不把来源变化当新事实；无法证明新颖时回退；关回旧模式后仍识别已刊新成员 | `report-gen.test.ts`、`pipeline-reportgen.integration.test.ts`、`reports.test.ts` |
| S2 | intent 已写而文件未落地；只落地 MD；双文件落地后调用方失联；重复/并发无锚 reconcile | 只恢复原 manifest 和原成员清单，或者留在不可见失败态；不会生成第二份正文、索引或重复通知 | `reports.test.ts`、pipeline 集成 |
| S2 | 外部锚部分写入、已写锚但 SQLite 未提交、重试收到不同 artifact 版本 | 只恢复原锚/版本；冲突标终态审计；不可见半成品不会被读到 | `reports.test.ts`、完整性发布集成测试 |
| S2 | intent 后改 live Insight/Citation/check、Story manifest/hash、成员顺序、MD/HTML 字节或引用编号 | 发布 guard 阻断不一致；已完成报告仍按原固化 artifact 读取，不从 live 行重构 | `reports.test.ts`、pipeline 集成、读路径测试 |
| S2 | shadow 运行、无 batch、失败/部分分析、合法空 Brief | shadow 不写生产发布历史/通知；无 batch 和失败保留终态；空刊沿用现有契约 | pipeline 集成与调度测试 |
| S2 | 删除、redaction、retention，包含 intent 未提交与已发布新格式 | 新包和历史索引随生命周期受控，读端/恢复端都不能泄漏被删 quote；旧报告不迁移 | `report-redaction-boundary.test.ts`、`integrity-lifecycle.test.ts`、route 集成 |
| S3 | 同一固化 Story 在 Markdown、HTML、页面、预览、卡片、报告索引、通知、PPT/导出中呈现 | 成员文本、顺序、事实数、单源标识和引用编号一致；不支持新格式的入口显式禁用且可验证 | `report-gen.test.ts`、页面/卡片测试、PPT 与 route 测试、必要 e2e |
| S3 | 发布后修改 batch/validator/选择策略，再读取所有展示面 | 展示仍引用发布时固化成员；PPT 不通过当前 batch 重新选取另一套事实 | `ppt-export.test.ts`、路由与 reader 集成 |
| S3 | 试点 on→off→on、旧镜像读取新格式、紧急关闭开关 | 已刊 artifact 不变；生成路径可关闭；启用前记录最低兼容镜像并验证读路径 | pipeline 集成、部署核验记录 |

## 验收口径

验收时分别报告：合格成员分母、Story 数、错并/漏并、未绑定断言、必要限定、旧模式回归、恢复结果、各展示面差异；不能用测试文件总数代替这些观察。若归组使用模型，或改 prompt、validator、数据源/评测集，再按 `eval-gate` 跑对应语义门；确定性 report-gen 变更必须跑上述生产路径回归、受影响测试、`npm run typecheck`，涉及路由/构建时再跑 `npm run build`。
