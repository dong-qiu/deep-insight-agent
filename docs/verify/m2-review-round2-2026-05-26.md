# M2 评审修复 round2（剩余 🟡）

## 2026-05-26 · 8 项稳健性/正确性修复

round1 收口 4 个 🔴 后，round2 处理评审剩余的 🟡 项。全部为确定性逻辑，配套单测（无 key 可跑）。

| # | 问题 | 修复 | 测试 |
|---|------|------|------|
| 1 | Cost Meter 并发不隔离：pipeline 读全局 meter 做差，并发跑会串成本 | `callStructured` 加 `onCost` 回调，每次调用（含重试）按返回值透传；agent 把 `ctx.recordCost` 传下去；pipeline 不再读全局做差。全局 meter 仅留给 eval harness 单线程总额 | — |
| 2 | 护栏 `releasable` 用引用级口径，与 report-gen 洞察级纳入判定可能错位 | 抽 `insightInclusion(checks)`（与 `selectInsights` 同口径），`summarize` 写时一次性算定 `releasable` + 新增 `insights_total/insights_includable` 并**随 validation_result 落库为列**（读回直接取列，三者同源、内部自洽、可 SQL 查、审计保真）；加幂等 `ALTER ADD COLUMN` 迁移兼容老库 | `summarize` 5 例（空批次/全 blocked/混合/flagged/分组） |
| 3 | `getReport` FS 读无兜底（孤儿 DB 行会抛）；`saveReport` 落库失败留 FS 孤儿 | getReport 捕获 FS 缺失→占位正文+告警；saveReport 落库失败→清理已写 FS | getReport FS 缺失兜底 1 例 |
| 4 | collector 手搓 insertRun/finishRun，未走 Job Runner | 统一经 `runJob`（与其它 agent 一致：单调时钟耗时 + 失败捕获 + 可重试） | 经现有 jobs 测试覆盖 |
| 5 | robots 把所有非 200 当「放行」，未区分 5xx | 抽 `rulesForStatus`：2xx 解析 / 4xx（含 404 无 robots）放行 / 5xx 保守全站禁止 | `rulesForStatus` 4 例（200/404/403/503） |
| 6 | Run.duration 用墙钟差（NTP 跳变会负值/突跳） | `runJob` 用 `performance.now()` 单调测耗时传入 `finishRun`，墙钟仅兜底 | — |
| 7 | `fetch_status=partial` 从未被设置（AC9 未实现） | 正文超 `MAX_BODY_CHARS` 截断并标 `partial` | normalize partial 2 例 |
| 8 | XML/feed 无大小上限，巨大响应可撑爆内存 | `readTextCapped` 流式读取超 `MAX_RESPONSE_BYTES`(8MB) 即中止抛错；arxiv/rss 接入 | — |

**验证**：typecheck 干净 · vitest **78/78**（round2 +12）· `next build` 绿。

**结论**：M2 评审项（round1 4×🔴 + round2 8×🟡）全部收口。校验护栏口径自此与成文一致；
采集/成本/时长/合规的边界行为补齐。剩余 🟢（纯风格）随手做即可，不单列。
