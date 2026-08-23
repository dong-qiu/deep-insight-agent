# Spec: 来源 credit 溯源事实（P1b-1）

> 状态：已由 INSI-15 的实现准入任务定义；仅允许 task-local SQLite 与合成/许可 fixture。它不改变 `source-cost-roi.md` 的源健康读时计数口径，也不实现 P1a funnel、成本、validator 或 rollup。

## 事实契约

每次可归因输出以一个调用方提供的稳定 `event_id` 写入 `source_credit_event`，并为每个来源写一条不可变 `source_credit_fact`。当前服务端固定写入 `tenant_id=default`；所有索引均从 tenant 开始，客户端没有提交 tenant 的路径。

`source-credit-v1` 是唯一 schema version，`equal-split-micros-v1` 是唯一 allocation version，`source-credit-producer-v1` 是唯一 producer version。每个 event 固定有 `1,000,000` micro-credits；来源 ID 经字典序排序后平分，余数依序加一。因此任一 event 的 credit 总和严格等于 `1,000,000`，不会出现浮点舍入或重试加写。

每个 source 必须附已受控的 `source-v1:<sha256>` revision。事实不保存内容、prompt、模型响应、凭据或报告正文。

## 幂等、冲突与迟到

相同 `(tenant_id,event_id)` 和相同 canonical semantic payload 重放原结果，不新增 credit 行；不同 payload 追加 `source_credit_conflict` 后以稳定错误 `source_credit_idempotency_conflict` 拒绝，绝不覆盖原 event。

`occurred_at` 与 `ingested_at` 都是 UTC RFC 3339 instant。入库不足 24 小时为 `timely`；超过 24 小时且不超过 7 天为 `reconcilable`；超过 7 天为 `quarantined`。全部迟到 event 都进入 `source_credit_late_event`，并只能通过追加 `source_credit_late_reconciliation`（`reconciled` 或 `declined`）记录对账决定；本期不改写任何日报或 rollup。

## 覆盖度与边界

coverage 从已有 trace 和 `provenance_started_at` 推导：缺 trace、切换点前 trace 或未知切换点必为 `legacy`；已有 trace 的 `partial` 保持 `partial`；只有切换点后已有 trace 且 coverage 为 complete 才为 `complete`。调用方不能把旧 trace 伪装成 complete。

本切片仅提供 task-local SQLite 的 append writer、迁移和测试。它不接入已发布报告读取、报告选择、引用白名单、驾驶舱查询或生产部署。
