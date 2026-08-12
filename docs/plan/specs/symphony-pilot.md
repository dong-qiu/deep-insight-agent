# OpenAI Symphony 开发管理试点

## 目标

用 GitHub Issues 作为任务控制面与 GitHub PR 作为交付事实源，在**非生产**宿主机以低并发运行 OpenAI Symphony。每张合资格 Issue 获得独立 workspace 与 Codex 会话；成果只能交接到人工审查，不能自动合并或部署。

这实现的是开发管理试点，不是把 Symphony 接入 Insight Agent 的业务生产环境。

## 范围

- `dong-qiu/deep-insight-agent` 中带 `agent-ready` 的开放低风险 Issue；首轮并发固定为 `1`。
- 每个 Issue 创建隔离 workspace、feature branch 和 GitHub PR。
- 记录运行日志、PR、CI、审查反馈、重试和人工交接结果。
- 仓库内版本化 `WORKFLOW.md`，使任务选择、验证和交接策略可审查。

## 非范围

- 自动合并、自动关闭 Issue、自动部署或生产故障处置。
- 访问生产 AWS/SSM、生产 SQLite、生产 `.env.local` 或任何生产密钥。
- 替代人工 dogfood 标签、产品决策、架构决策或 PR 审查。
- 同时接入 Linear，或把 GitHub Issues 与其他 tracker 做双向状态同步。

## 状态机

```text
open + agent-ready ──► agent-working ──► agent-human-review ──► human closes Issue
        ▲                    │                    │
        └── human re-adds ───┘                    └── human re-adds agent-ready for rework
                             │
                agent-needs-human / agent-blocked
```

- GitHub adapter 仅使用 Issue 的 `open` / `closed` 状态；试点工作状态全部由标签表达。只有开放且带 `agent-ready` 的 Issue 可被派发。
- 编排器在启动 Codex 前添加 `agent-working`，再移除 `agent-ready`；继续运行和重启恢复只认 `agent-working`。因此 agent 不会因移除派发标签而在下一轮停止，也不会重复领取。
- `agent-human-review`、`agent-needs-human` 与 `agent-blocked` 是 controller 的停止标签：任一存在都终止续跑且禁止带残留 `agent-working` 的 Issue 被重新派发。agent 只能添加、不能移除停止标签；完成交接时 agent 添加 `agent-human-review` 并评论 PR、测试与 CI 证据；人工在确认没有运行会话后移除 `agent-working`，并在合入后关闭 Issue。
- 返工由人类移除 `agent-human-review` 并重新添加 `agent-ready`；agent 不关闭 Issue。缺少验收标准、权限或外部决策时，agent 添加 `agent-needs-human` 或 `agent-blocked`，并移除调度标签。

## 安全与权限模型

| 能力 | 试点允许 | 强制约束 |
| --- | --- | --- |
| GitHub Issues | 仅读取本仓库开放 Issue；更新试点标签与评论 | fine-grained token 仅限本仓库；host-side allowlist 绑定当前 Issue；token 仅在 Symphony 宿主机；不写入 `WORKFLOW.md` |
| GitHub 代码 | 创建 feature branch、推送、创建/更新 PR、读取 CI | 保护 `main`；不授予 Actions、Environments、Administration、Secrets、Webhooks、Deployments 或包管理权限；禁止合并 |
| Codex | 仅在每 Issue workspace 中运行 | Symphony 从子进程移除 tracker token；不继承 AWS 凭据或生产 env；按 `WORKFLOW.md` 执行 |
| 生产环境 | 不允许 | 宿主机无 AWS profile、SSM、生产网络、生产数据卷和 `.env.local` |

Symphony 宿主机必须使用专用 OS 用户与独立 workspace 根目录，目录权限仅允许该用户访问。工作区不得复用本地开发 checkout，也不得挂载生产卷。

> GitHub adapter 将 provider-native `github_api` 暴露给 Codex，但 host-side allowlist 将它绑定到配置仓库和当前 Issue：仅可读取该 Issue、评论、操作声明的 agent 标签，以及按固定 base/branch-prefix 创建该 Issue 的 PR。Issue 关闭、PR 合并、refs、仓库设置和跨仓库/跨 Issue 路径会在发请求前拒绝。token 必须是仅限 `dong-qiu/deep-insight-agent` 的 fine-grained token；不能使用账户级 OAuth token、classic PAT 或可访问其他仓库的 token。

## 验收标准

1. `WORKFLOW.md` 的 YAML 可由 Symphony 解析，且不含任何字面量密钥。
2. 未设置 `SYMPHONY_GITHUB_TOKEN` 或 `SYMPHONY_WORKSPACE_ROOT` 时，服务必须拒绝开始派发。
3. 只有开放且带 `agent-ready` 的 Issue 可被领取；controller 必须先加 `agent-working` 再移除 `agent-ready`，全局并发不超过 `1`。
4. 同一仓库只允许一个 controller：Hardened Symphony runtime 启动时必须获得与仓库绑定的排他锁，拿不到锁则拒绝启动。
4. 每个试点 Issue 在独立 workspace 中工作，且只能创建 feature branch 与 PR；不能合并、关闭 Issue 或部署。
5. 成功运行的交接标签为 `agent-human-review`，并包含 PR、测试和 CI 证据。
6. 首轮至少完成 3 个低风险 Issue；连续累计 10 个 Issue 后评估 CI 通过率、人工返工率、重试、成本、遗留 workspace 与越权事件，再决定是否将并发提高到 `2`。

## 上线前人工前置项

1. 在 `dong-qiu/deep-insight-agent` 创建 `agent-ready`、`agent-working`、`agent-human-review`、`agent-needs-human`、`agent-blocked` 标签；只有低风险且验收标准完整的开放 Issue 才加 `agent-ready`。
2. 创建两个仅限该仓库的 GitHub 身份：tracker fine-grained token 仅授予 Issues read/write、Pull requests read/write、Metadata read；Git push 使用独立、仅限该仓库的 deploy key 或非管理员 bot 身份。两者都不授予 Actions、Environments、Administration、Secrets、Webhooks、Deployments 或其他仓库权限，且 bot/deploy key 对 `main` 无 bypass。在宿主机设置 `SYMPHONY_GITHUB_TOKEN`。
3. 创建非生产宿主机的专用 OS 用户，安装 Codex、Git、Node 20、npm 10 与 Symphony runtime；设置 `SYMPHONY_WORKSPACE_ROOT`。
4. 确认 `main` 分支保护，并在试点前用无 `agent-ready` 标签的开放 Issue 验证 token、零派发和 workspace 隔离。
5. 在 `docs/launch/symphony-pilot.md` 的 preflight 全部通过前，不启动常驻服务。
