# P0a 生产报告纵切验收 — 2026-08-04

## 范围与结论

**结论：报告纵切通过；P0a 正式 Brief AC 仍待一条生产 Brief 样本。**

本次通过正常管理员 HTTP 请求触发生产 Deep Dive，验证了从 durable dispatch 到报告、技术线索、方向映射和机会派生的真实链路。它不能替代
`generation-provenance.md` 中明确要求的“任一生产 Brief”验收样本，因此不勾选该 AC。

## 可复查事实

| 项目 | 证据 |
| --- | --- |
| 主题 | `t_code_agents`（AI 时代的软件工程） |
| Trace | `trace_a72fb641930a4fce8ca33b8ba0bcffa5` |
| 请求结果 | 管理员 API 返回 `202 accepted`；同一请求在 worker 热修后由 `attempt=1` 领取 |
| 终态 | `done`，coverage=`complete`，无 dispatch error |
| 根 Run | `run_061b212609e641e6a0e0bcd49e90411a` |
| 报告 | `rep_bba4662a`（output entity ref） |
| 运行镜像 | Git `624f5a53c258af4ca396d9326e029e7f0f6a9506`；digest `sha256:ce2d58a878a218902d771b95c6da086035f48768306d50133bf2c70514368282` |

Trace 按顺序写入了 12 个事件：`analyze`、`validate`、`derive_lead`、`map_direction`、`derive_opportunity`、`generate_report` 的
started/completed 成对事件。实体引用包括 75 个 Content 输入、6 个 AnalysisBatch 输入、ValidationResult 输入/输出、23 个
TechLead 输出和 1 个 public-evidence Report 输出。

## 权限验收

- 管理员：报告详情显示“生成溯源”时间线，可读取 trace API 与发布引用下钻。
- Viewer：可读取已发布报告正文；不显示 trace、引用下钻、屏蔽校验细节或成本；访问 trace API 被拒绝。

该角色验证由负责人在生产环境完成；不在文档中记录账号、cookie 或任何凭据。

## 本次发现与修复

首次请求曾长期停在 `queued`：worker 的机器请求先被浏览器 session/IP rate-limit middleware 拦为 `429`，且 worker 对非 2xx 无退避。
PR #198 修复为“正确机器密钥才豁免这两道浏览器门禁、路由继续二次校验、失败请求 5 秒退避”。热修部署后，同一个既有 trace 被成功领取并完成，构成生产等价回归证据。

## 空队列观察

在热修镜像启动后检查 `generation-dispatch-worker`：容器保持 `running=true`、`restart_count=0`，从启动至检查时
`HTTP 429` 计数为 0。日志中有一次服务重建期间的 `fetch failed`，未形成重试风暴；其余时间空队列轮询正常。

## 后续

1. 在 `provenance_started_at` 后取得一条生产 Brief，按同一口径验证 trace、pass 引用、版本/镜像与角色边界后，才勾选 P0a Brief AC。
2. 观察空队列 worker，确认无新增 `HTTP 429` 忙等。
