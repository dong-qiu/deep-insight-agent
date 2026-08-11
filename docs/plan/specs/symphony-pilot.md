# OpenAI Symphony 开发管理试点

## 目标

用 Linear 作为任务控制面、GitHub 作为代码与交付事实源，在**非生产**宿主机以低并发运行 OpenAI Symphony。每张合资格工单获得独立 workspace 与 Codex 会话；成果只能交接到人工审查，不能自动合并或部署。

这实现的是开发管理试点，不是把 Symphony 接入 Insight Agent 的业务生产环境。

## 范围

- Linear 项目中的 `agent-ready` 低风险工单；首轮并发固定为 `1`。
- 每个工单创建隔离 workspace、feature branch 和 GitHub PR。
- 记录运行日志、PR、CI、审查反馈、重试和人工交接结果。
- 仓库内版本化 `WORKFLOW.md`，使任务选择、验证和交接策略可审查。

## 非范围

- 自动合并、自动关闭关键工单、自动部署或生产故障处置。
- 访问生产 AWS/SSM、生产 SQLite、生产 `.env.local` 或任何生产密钥。
- 替代人工 dogfood 标签、产品决策、架构决策或 PR 审查。
- 同时把 GitHub Issues 和 Linear 做双向状态同步。

## 状态机

```text
Triage / Needs Human / Blocked
             │ 人工补足验收标准并加 agent-ready
             ▼
           Ready ──► Agent Working ──► Human Review ──► Done
                                  ▲        │
                                  └─ Rework ┘
```

- 仅 `Ready`、`Agent Working`、`Rework` 是 Symphony 活跃状态；`agent-ready` 是必要标签。`Agent Working` 是 Symphony 专属状态，人工进行中的工作不得使用它；服务重启后才能安全重新领取该状态的遗留工单。
- `Human Review`、`Needs Human`、`Blocked` 均不可调度。进入这些状态会使本次 agent 交接或停止。
- 只有人工可以将 `Human Review` 转为 `Done`，或把工作转回 `Rework`。
- 缺少验收标准、权限或外部决策时，agent 必须移至 `Needs Human`，而非自行扩大范围。

## 安全与权限模型

| 能力 | 试点允许 | 强制约束 |
| --- | --- | --- |
| Linear | 读取试点项目；评论、附 PR 链接、转换试点状态 | 使用专用低权限账号；token 仅在 Symphony 宿主机；不写入 `WORKFLOW.md` |
| GitHub | 创建 feature branch、推送、创建/更新 PR、读取 CI | 保护 `main`；不授予 Actions、Environments、Administration 或包管理权限；禁止合并 |
| Codex | 仅在每工单 workspace 中运行 | 不继承 Linear token、AWS 凭据或生产 env；按 `WORKFLOW.md` 执行 |
| 生产环境 | 不允许 | 宿主机无 AWS profile、SSM、生产网络、生产数据卷和 `.env.local` |

Symphony 宿主机必须使用专用 OS 用户与独立 workspace 根目录，目录权限仅允许该用户访问。工作区不得复用本地开发 checkout，也不得挂载生产卷。

> Linear adapter 的 `project_slug` 只约束调度器读取候选工单；其 provider-native GraphQL 工具仍能访问 token 本身有权访问的范围。因此必须让专用 Linear 账号仅加入试点项目；若做不到，试点不得启用该工具或应改用权限边界更窄的 tracker adapter。

## 验收标准

1. `WORKFLOW.md` 的 YAML 可由 Symphony 解析，且不含任何字面量密钥。
2. 未设置 `LINEAR_API_KEY`、`LINEAR_PROJECT_SLUG` 或 `SYMPHONY_WORKSPACE_ROOT` 时，服务必须拒绝开始派发。
3. 只有同时处于活跃状态且带 `agent-ready` 的工单可被领取；全局并发不超过 `1`。
4. 每个试点工单在独立 workspace 中工作，且只能创建 feature branch 与 PR；不能合并或部署。
5. 成功运行的交接状态为 `Human Review`，并包含 PR、测试和 CI 证据。
6. 首轮至少完成 3 个低风险工单；连续累计 10 个工单后评估 CI 通过率、人工返工率、重试、成本、遗留 workspace 与越权事件，再决定是否将并发提高到 `2`。

## 上线前人工前置项

1. 在 Linear 创建专用项目与状态：`Ready`、`Agent Working`、`Human Review`、`Rework`、`Needs Human`、`Blocked`、`Done`、`Canceled`；创建 `agent-ready` 标签。
2. 创建专用 Linear 账号/token，并限制其可见项目；在宿主机设置 `LINEAR_API_KEY` 与 `LINEAR_PROJECT_SLUG`。
3. 创建非生产宿主机的专用 OS 用户，安装 Codex、Git、Node 20、npm 10 与 Symphony runtime；设置 `SYMPHONY_WORKSPACE_ROOT`。
4. 配置仅限本仓库的 GitHub 凭据与 `main` 分支保护；在试点前用只读工单验证 token 和 workspace 隔离。
5. 在 `docs/launch/symphony-pilot.md` 的 preflight 全部通过前，不启动常驻服务。
