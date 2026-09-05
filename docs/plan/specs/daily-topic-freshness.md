# Spec: 日报主题新鲜度监控

> 状态：🟡 实施中；创建：2026-09-05。

## 目的

确保每个启用且 `brief_schedule=daily` 的主题独立维持日报产出。全局最新报告只能证明
系统曾产出报告，不能证明所有日报主题均正常，因此不得作为主题级 SLO 的替代。

## 范围与验收

1. `GET /api/health` 在不触发 LLM 或调度写入的前提下，读取每个启用日报主题最新的
   `done brief`，并返回低基数的 `dailyTopicCount` 与 `staleDailyTopicCount`。
2. 主题最新日报距当前时间严格大于 `STALENESS_ALERT_HOURS`（默认 26 小时）时为
   `stale`；一个新鲜主题不得掩盖另一个陈旧主题。
3. 新主题在创建后一个阈值窗口内尚未有日报时为 `pending_initial_report`，不产生陈旧告警；
   超过窗口仍没有 `done brief` 时为 `stale`。
4. 主题级陈旧告警必须按 topic 去重（`STALENESS_REALERT_HOURS`，默认 24 小时），在该
   主题恢复后清除去重状态，以便下一次真实事故立即通知。
5. 公开健康接口不得暴露 topic 名称或内部 trace；这些信息只可通过已配置的授权告警渠道
   发送。健康接口保持 200：业务陈旧不应触发容器重启。
6. 查询仅扫描启用日报主题及其 `done brief` 的聚合结果，且有单测覆盖：单主题陈旧、
   新鲜主题不掩盖另一主题、首报宽限、按主题告警去重/恢复。

## 非目标

- 不自动重试或重写失败的 generation trace；恢复动作仍由受审计的调度/管理路径执行。
- 不以报告生成时的展示标题推断业务日期；补跑必须继续以 trace/dispatch 中冻结的窗口为准。
- 不改变全局 app/DB liveness 或 worker queue-age readiness 的语义。
