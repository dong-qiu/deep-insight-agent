# 日报选择漏斗：生产抽样验收（2026-09-27）

## 结论与边界

**生产抽样验收通过。** 本记录对应 [Daily Brief 选择漏斗规格](../plan/specs/daily-brief-selection-observability.md)
和实现 PR #295，收敛其“已实现、待生产验收”状态，不重做或扩大既有 P0a/P0b/P0c 的验收范围。

证据分三层：生产计数只读核验、用户提供的单报告管理页面截图、同一报告的飞书接收端消息截图。
本记录仅提交聚合结果、方法和证据摘要；报告/Trace 明细、截图、原文及凭据均不入仓。

## 证据摘要

| 层次 | 方法与结果 | 不能据此推断 |
| --- | --- | --- |
| 生产数据 | readonly SQLite 单读事务，检查最近 14 份 `done` Brief；14/14 有 committed report-file effect 与关联 Trace，四阶段计数齐备，最终洞察/引用计数与报告一致 | 不是全部历史报告审计，也不是页面渲染验收 |
| 页面展示 | 用户提供管理看板目标行及展开的 Trace 截图；可见计数与只读结果一致，Trace ID 匹配，运行版本可见，分析/校验/报告生成的 started/completed 均可见 | 不覆盖全部 14 行、Viewer 权限或实体引用按钮的实际点击 |
| 告警送达 | 用户提供对应报告的飞书消息；报告/Trace ID、阶段计数和触发阈值均匹配 | 不证明所有通知必达、无重复，或跨进程 exactly-once |

检查时生产 app/worker 均运行 `fe11c15593196774c60ad88ecbcaed8774f7b6b9`，零重启。
14 份历史样本生成于 2026-09-11 至 2026-09-26，早于该版本部署。
页面样本的历史运行版本显示为 `b7507466357d0fb2ecd361f92754cfa43c9b0d6e`，并显示镜像 digest 与 schema；
历史版本不应被当前版本覆盖。本次只确认这些字段可见，不声称重新核验了历史镜像 digest。

当前配置的薄日报阈值为选中至少 10、最终发布至多 2，告警启用且 webhook 存在；
14 份样本中 1 份按当前阈值命中。配置检查没有输出 webhook、密钥或目的群信息。
**实际送达结论来自接收端截图，而非配置存在或 HTTP 成功。** 截图时间仅显示时分，未显示日历日期；
按与生产记录匹配的报告/Trace ID 绑定证据，不从截图推断精确送达日期或时延。

管理看板的部分选择/来源计数被省略号截断；详情面板提供完整计数，记录为非阻塞可读性优化。
新鲜度、去重和补充发现并非互斥减法桶，不能通过简单相减验证最终发布数量。

## 验收标准映射

| 规格要求 | 本次依据 |
| --- | --- |
| 选择行为不变，诊断计数准确 | `analysis-selection.test.ts` 确定性回归；生产数据核验 |
| Trace 受控指标与报告面板展示 | `provenance-facts.test.ts` 白名单回归；目标报告 Trace 截图 |
| 管理看板合并计数，legacy 保持未知 | `reports.test.ts` 真实投影与 legacy null 回归；单报告页面抽样。未声称完成 legacy 页面的人工复验 |
| 阈值、关闭开关、诊断正文与进程内去重 | `alert.test.ts` 回归；当前配置只读检查；匹配报告的实际飞书消息 |

`notifyThinBrief → notify → sendAlert` 仍为非阻塞通知，失败记录日志，没有新增持久化投递回执。
本次未重发通知、重跑日报、调整阈值或修改生产配置；不以验收名义引入 outbox 等新功能。

## 验证与私有证据

在源提交 `fe11c15`、Node `v24.19.0` 上执行：

- `npx vitest run src/lib/agents/analysis-selection.test.ts src/lib/db/reports.test.ts src/lib/runtime/alert.test.ts src/lib/db/provenance-facts.test.ts`：4 文件、192 测试通过。
- `npm run typecheck`：TypeScript 7 与 TypeScript 6 通过。
- 未运行 A1：本次不改变模型、prompt、validator、来源或评测口径；A1 也不执行该确定性可观测性验收路径。

维护者本机私有目录 `.data/p0-closeout-20260927/` 保存查询、聚合核验与三张用户截图，目录权限 0700、文件 0600；
它不是仓库制品，不保证其他 checkout 可访问。截图摘要如下，仅用于核对维护者持有的原件：

| 私有证据 | SHA-256 |
| --- | --- |
| 管理看板截图 | `e0e1f76f94aeacfb5483c4e89e9af29abbde30c1506c9fa4985a01bf35006249` |
| 报告 Trace 截图 | `e5546ceb5607c21d5a8fa261d70d30f1c1c055587bb663ba00e2bd50d4afa050` |
| 飞书接收端截图 | `c00e4c21ae9c65aa3e8ae2c47502e22c2546b4948792129ba25100fbef48c7a1` |

## 独立待办，不扩大本次结论

- Linear 尚未连接，P0 父子任务实时状态未核实；仓库完成状态及 PR 合并不等于任务系统已经关闭。
- `fe11c15` 上线后的正常新日报生成回归另行记录；上述历史样本不替代新版本中文结论、引用及链路检查。
- P0 原验收由 [generation-provenance §9](../plan/specs/generation-provenance.md#9-验收标准) 和 PR #332 记录；
  P1 继续 [dormant](../plan/p1-dormant-reentry.md)，完整 A1、播客双源评测及模型误拒优化不作为本次收口前置项。
