# P0a 生产 Brief 验收运行手册

## 目的与通过条件

本手册用于完成 `docs/plan/specs/generation-provenance.md` 的 P0a Brief 验收标准。它只接受一次**正常 UTC 17:00 cron** 产生的、`provenance_started_at` 之后的生产 Brief；手工重复运行、同日重放或 Deep Dive 均不能替代该样本。

通过需要同时满足：

1. 至少一份当日生产 Brief 为 `done`、非空（`insight_ids.length > 0` 且 `citation_count > 0`）。
2. 管理员报告页可在同一页面下钻到对应 trace，trace/dispatch 均为终态 `done`，coverage 为 `complete`。
3. `analyze`、`validate`、`generate_report` 均有 started/completed 终态；报告 output entity ref 指向该 Brief。
4. 报告的所有发布引用均为 validator `pass` / `support` 白名单；不得有 `blocked`、`flagged` 或无校验引用进入正文。
5. 同一报告页面的 trace 下钻中可见运行镜像 revision/digest、输入批次、纳入洞察与 pass 引用；管理员/Viewer 边界保持既有 P0a 约束。

空 Brief 不是生产故障：若其 `generate_report.completed.reason_code` 为 `no_significant_event`、`no_new_publishable_insight` 或 `no_publishable_insight`，记录原因并等待下一个正常 cron 样本。不得将空刊写成通过或失败。

## 运行前检查

- 生产运行版本应为目标主干提交，`app`、`cron` 和 `generation-dispatch-worker` 均为 running，`/api/health` 成功。
- 观察期设置 `BRIEF_ACCEPTANCE_WATCH=1`。它仅在未满足验收条件时向 `ALERT_WEBHOOK` 发送告警；通过时静默。
- 记录验收前的 UTC 时间、目标镜像 revision 与 deployment workflow 链接。不得在文档记录 `.env.local`、cookie、账号、token、原始正文或 URL。

### 运行事实状态与 UI 核验

历史 Blocker 已于 `86f3162` 对应生产镜像解除：`GET /api/generation-traces/{id}` 现在仅投影经白名单校验的
`runtime_version`，报告页在管理员时间线中展示 Git revision、镜像 digest 和 provenance schema。

2026-08-07 的正常 UTC 17:00 cron 已在生产 Trace 中冻结 Git `86f31621…`、镜像
`sha256:e054a22f…` 和 schema `20260803_06_provenance_facts`，详见同日期验收记录。这是运行时的交叉证据，
但不能替代管理员页面和 Viewer 边界的人工可视化抽样；在抽样完成前，不得将 P0a Brief AC 标为通过。

## 正常日报后的验收步骤

在 UTC 17:00 cron 触发后，等待采集、dispatch worker 和主题流水线完成；不要在同一 UTC 日期手工调用 `/api/cron`。

1. 以管理员身份打开报告库，找出本次 cron 生成的 `brief`。若所有 Brief 均为空，转到“空刊处理”。
2. 打开一份非空 Brief，记录 report ID、topic、生成时间、洞察数和引用数。
3. 在同一报告页展开“生成溯源”，记录 trace ID，并确认 output `report` ref 的 ID 与当前报告一致。
4. 在时间线确认 `analyze`、`validate`、`generate_report` 有成对终态，且 `generate_report.completed` 的 `published_insight_count`、`published_citation_count` 均大于 0。
5. 在报告页“发布引用下钻”确认每一条显示为 pass/support；记录显示数量，并与报告 `citation_count` 一致。
6. 记录 trace 的 dispatch 状态、attempt、coverage、root Run 和运行镜像 revision/digest。若页面没有显示版本事实，记录“UI 版本事实缺失” Blocker；生产 Trace 和 deployment record 只能作为交叉证据。出现 `partial`、`failed`、缺失 output ref 或数量不一致时，同样判定为未通过并保留稳定 reason code。
7. 用 Viewer 账号（或既有受限会话）抽样确认：可读取报告正文，但不显示生成溯源、引用下钻、屏蔽校验或成本；trace API 仍拒绝访问。不要在验收文档记录身份凭据。

## 空刊或异常处理

| 情况 | 处理 | 是否可通过 |
| --- | --- | --- |
| `no_significant_event` | 记录为正常空刊，等待下一次 cron | 否 |
| `no_new_publishable_insight` | 记录新鲜度/已发布去重计数，等待下一次 cron | 否 |
| `no_publishable_insight` | 记录统计，检查后续是否出现 validator/选择异常 | 否 |
| trace/dispatch failed 或 partial | 保留 trace ID 与稳定 reason code，按运行失败处理 | 否 |
| 非空但 citation_count 为 0、output ref 缺失或白名单不一致 | 视为 P0a Blocker，停止勾选 AC | 否 |
| 管理员报告页未显示 runtime version / 镜像 digest | 记录为 UI 版本事实缺失，先补 read model 再正式验收 | 否 |

## 验收记录模板

正常样本出现后，复制下面模板到 `docs/verify/p0a-brief-production-acceptance-YYYY-MM-DD.md`，填入可复查 ID 和稳定状态；不要填入任何凭据或原始内容。

```md
# P0a 生产 Brief 验收 — YYYY-MM-DD

## 结论

**通过 / 未通过 / 待下一份正常 Brief 样本**

## 可复查事实

| 项目 | 证据 |
| --- | --- |
| 主题 | `<topic_id / 名称>` |
| Report | `<rep_…>` |
| Trace | `<trace_…>` |
| 触发 | 正常 UTC 17:00 cron |
| trace / dispatch | `done` / `done`，attempt=`<n>`，coverage=`complete` |
| 根 Run | `<run_…>` |
| 报告 output ref | `<rep_…>`（与 Report 一致） |
| 发布洞察 / 引用 | `<n>` / `<n>` |
| pass/support 引用 | `<n>`（与 citation_count 一致） |
| 运行镜像 | Git `<sha>`；digest `<sha256:…>` |

## 阶段与过滤证据

- `analyze`：输入 `<n>`，洞察 `<n>`，终态 `<…>`。
- `validate`：总引用 `<n>`，pass `<n>`，blocked `<n>`，flagged `<n>`，终态 `<…>`。
- `generate_report`：发布洞察 `<n>`，发布引用 `<n>`，reason code `<… 或无>`。

## 权限抽样

- 管理员：`<结果>`。
- Viewer：`<结果>`。

## 后续

- [ ] 将 generation-provenance.md 的 P0a Brief AC 标记为通过，并更新 roadmap。
- [ ] 关闭 `BRIEF_ACCEPTANCE_WATCH`。
```

## 通过后的收尾

1. 提交实际验收记录，并将 `generation-provenance.md` 与 `docs/plan/roadmap.md` 的 P0a Brief 状态更新为通过。
2. 将生产 `BRIEF_ACCEPTANCE_WATCH` 关闭或删除，并以当前不可变镜像重启相关服务；保留 deployment/trace ID。
3. 如未通过，保持观察期开关，先处理 Blocker；不要提前更新 P0a 状态。
