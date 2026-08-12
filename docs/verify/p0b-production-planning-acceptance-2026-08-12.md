# P0b 生产规划溯源验收 — 2026-08-12

## 结论

**通过。**

本次验收以管理员通过单主题 Daily Brief 入口触发的生产 trace 为自动样本，及一次已完成的管理员方向编辑为人工样本。
两者均在生产 SQLite 中只读核验；未修改生产数据。

## 自动机会链路

| 项目 | 证据 |
| --- | --- |
| 主题 / Daily Brief trace | `t_code_agents` / `trace_7c058fe160284ee3863077650e1328b8` |
| 触发与执行 | admin API 受理；`topic_pipeline`、`api`；dispatch `done`、attempt=`1`、coverage=`complete` |
| 管理员审计 | `topic_brief_trigger`，actor=`admin`，`select/planned` event 带 audit ID=`2` |
| 自动阶段 | `analyze → validate → derive_lead → map_direction → derive_opportunity → generate_report` 均有 started / completed 终态 |
| 自动输出 | 15 条 Content revision 输入；11 条 TechLead 输出；16 条 TechnologyOpportunity 输出；报告生成完成 |
| 方向输入 | `map_direction` 写入 3 个不可变 Direction revision：`direction-v1:a817…`、`direction-v1:ae27…`、`direction-v1:e75a…` |

抽样 Opportunity：`opp_d2d07cb4-cd9`。

- 其关联 Lead 是 `lead_e6b2b714-612`，机会—线索关系由 `opportunity_lead` 保存。
- 它映射至 `dir_code_context_engineering`，lane=`core`、planning effect=`reinforce`，Direction version=`2`，mapping state=`current`。
- 对应 `tech_lead_direction_map` 保留 mapping lane、fit score=`75` 和命中理由（`skills`）；因此不是从当前 UI 或可变规则反推历史映射。
- priority=`82`，评分明细固定为：方向匹配 `30`、已校验证据 `12`、重要性 `16`、可验证性 `15`、时效 `9`；总分与明细一致。
- 同一 trace 的 `derive_opportunity` 事件写入该 Opportunity output ref；`derive_lead`、`map_direction` 的 Lead / Direction input ref 与之处于同一 trace 中，可逐层回溯。

## 人工决定链路

人工 Direction 编辑样本：`trace_a4ca60be9f964bf89ba64363c1ddeae3`。

| 项目 | 证据 |
| --- | --- |
| 类型 / 状态 | `manual_decision` / `done`，trigger=`api` |
| actor | `admin`，`direction_change/started` 与 `config_changed` 均保留 actor |
| 审计 | `audit_log` ID=`1`；`topic_direction_update`；版本 `1 → 2` |
| 历史版本 | input=`direction-v1:783235…`；output=`direction-v1:a817…` |

该样本证明人工决定、审计、事件与方向前后 revision 在同一事务留下历史事实；后续自动日报使用的
`direction-v1:a817…` 仍可作为独立输入 revision 被追溯，未被当前业务行覆盖。

## 权限与 UI 抽样

- 管理员已完成：在技术规划的 Direction workbench 可见该方向的最近 Trace / 时间线；Viewer 已确认不能看到同类内部溯源信息。
- 自动 Opportunity 页面以 `isAdmin` 条件显示同一 `ProvenanceTimeline`，并从已验证的 Opportunity output ref 定位 trace；生产数据库的
  output ref 和本记录的自动样本证明其解析对象存在且唯一。Viewer 路径不渲染该组件，generation-trace API 亦有 middleware 与
  handler 的双重拒绝。
- 单主题日报入口已于同日生产部署：受理后直接显示 trace ID 和“查看生成溯源”链接，避免依赖浏览器开发者工具。

## 范围与后续

- 本记录完成 P0b 的自动规划、人工 Direction 决定、历史 revision 和权限边界生产验收；不把候选 Opportunity 解释为研究、PoC
  或项目批准。Opportunity 的人工分诊属于后续 dogfood 工作流，不伪造为本次生产事实。
- P0c 的容量、分页、图预算与生产规模性能门仍未实施，不能由本次验收代替。
