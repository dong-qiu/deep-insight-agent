# P0a 生产 Brief 验收 — 2026-08-08

## 结论

**通过。**

UTC 17:00 的正常 cron 生成了 provenance 切换点后的非空生产 Brief。管理员在同一报告页面完成了溯源和发布引用下钻；Viewer 只能阅读发布报告，不能看到生成溯源或受限校验信息。

## 可复查事实

| 项目 | 证据 |
| --- | --- |
| 主题 | `t_code_agents`（AI 时代的软件工程） |
| Report | `rep_ecffa2f6`，`done`，生成于 `2026-08-08T17:14:44.222Z` |
| Trace | `trace_b82a5c9749d642098db2d18fd9b64e38` |
| 触发 | 正常 UTC 17:00 cron；trace 开始于 `2026-08-08T17:00:43.347Z` |
| trace / dispatch | `done` / `done`，attempt=`1`，coverage=`complete` |
| 根 Run | `run_9538ff868f1243bdad20430655ec4ee5` |
| 报告 output ref | revision=`rep_ecffa2f6`，与 Report 一致 |
| 发布洞察 / 引用 | `8` / `23` |
| pass/support 引用 | `23`，与 `citation_count=23` 一致；已发布洞察中 `blocked=0`、`flagged=0` |
| 运行镜像 | Git `da030b7b027e6dfe60a1b24d24711f2e12b4cf8c`；digest `sha256:82e404f4f28ba0b4a7988b90ecd9f389e0851ad3e97f0cca01d352f580592991` |

## 阶段与过滤证据

- `analyze`：输入 `15`，洞察 `18`，started/completed 均存在，`no_significant_event=0`。
- `validate`：总引用 `76`，pass `75`，blocked `1`，flagged `0`，errored `0`；`insights_includable=18`、`releasable=true`，started/completed 均存在。
- `generate_report`：发布洞察 `8`，发布引用 `23`，`freshness_filtered_insight_count=10`、`already_published_filtered_insight_count=0`，started/completed 均存在，无空刊 reason code。

`derive_lead` 在该 trace 中为非阻断阶段且记录为 failed；它不改变报告 trace / dispatch 的 `done` 终态，也不影响本 Brief 的已发布引用白名单。

## 权限抽样

- 管理员：可在同一非空报告页面看到生成溯源、运行版本、阶段时间线、output ref 和 `23` 条 pass/support 发布引用。
- Viewer：可读取报告正文；不可看到生成溯源、引用下钻、屏蔽校验或成本，trace API 保持拒绝访问。

## 独立稳定性跟踪

同一 cron 的 `t_ai_industry` trace `trace_1d386374bf7643be811eb2f3b93126c7` 因 `provenance_revision_conflict` 以 `dispatch_failed` 终止，且未留下阶段事件。该主题失败不改变本条成功 Brief 的验收事实；它作为 P0a 稳定性问题 [#210](https://github.com/dong-qiu/deep-insight-agent/issues/210) 单独跟踪与修复。

## 后续

- [x] 将 generation-provenance.md 与 roadmap 的 P0a Brief 状态更新为通过。
- [x] 在 UTC `2026-08-08T17:38Z` 的受控生产操作后关闭 `BRIEF_ACCEPTANCE_WATCH`；app、cron 与 generation-dispatch-worker 均以记录的不可变 digest 重建并通过健康核验。
