# OpenAI Symphony 试点运行手册

> 仅用于非生产宿主机。参见 `docs/plan/specs/symphony-pilot.md` 与根目录 `WORKFLOW.md`。

## 0. 运行前边界

- 不在生产 EC2、开发者主 checkout、共享 SQLite 卷或能访问生产 AWS/SSM 的机器上运行。
- 使用专用 OS 用户；该用户不拥有 `~/.aws`、生产 `.env.local`、生产数据库、SSH 生产 key 或部署凭据。
- Linear token、GitHub 凭据和 Codex 登录状态只保存于该用户的宿主机密钥管理/环境配置，绝不写入仓库或 workspace。
- `main` 必须受保护，并要求 PR 与 CI；Symphony 无自动合并或部署权限。
- 服务管理器只注入试点必需环境变量，且显式清除 `AWS_*`、`AWS_PROFILE`、`DATABASE_URL`、`DB_PATH`、`DISPATCH_WORKER_SECRET` 及所有生产应用变量。

## 1. Linear 控制面

创建一个仅供试点使用的 Linear 项目，并配置状态：

`Triage`、`Ready`、`Agent Working`、`Human Review`、`Rework`、`Needs Human`、`Blocked`、`Done`、`Canceled`。

创建标签 `agent-ready`。只有验收标准、风险范围和完成定义均明确的低风险工单才由人工添加该标签。不要把生产故障、数据库迁移、人工 dogfood 标注或产品/架构决策标为 `agent-ready`。

Linear 的 `project_slug` 只限制 Symphony 调度器读取候选工单，不能限制 provider-native GraphQL 工具本身。专用 Linear 账号必须不具备试点项目外的访问权限；否则停止在此处，不要依赖 prompt 作为权限隔离。

## 2. 宿主机环境

安装 OpenAI Symphony 的参考实现所需 runtime，以及 Codex app-server、Git、Node 20 与 npm 10。OpenAI 的参考实现使用 Elixir/Erlang，并以 `mix setup` / `mix build` 后运行 `bin/symphony`；版本和安装方式以其 README 为准。

由服务管理器或宿主机密钥管理将 `LINEAR_API_KEY`、`LINEAR_PROJECT_SLUG` 与 `SYMPHONY_WORKSPACE_ROOT` 注入专用服务账号；不要通过交互式 `export` 设置 token。`SYMPHONY_WORKSPACE_ROOT` 固定为 `/srv/symphony/insight-agent-workspaces`。

不要在 shell history、systemd unit 文件、`WORKFLOW.md` 或仓库 `.env` 中写 token。GitHub 凭据应限于本仓库的 branch/PR 操作；保护规则必须拒绝直接更新 `main`。

## 3. Preflight

在服务管理器已注入环境、且以专用 `symphony` OS 用户运行的 preflight 中逐项确认：

```sh
test -n "$LINEAR_API_KEY"
test -n "$LINEAR_PROJECT_SLUG"
test -n "$SYMPHONY_WORKSPACE_ROOT"
expected_root='/srv/symphony/insight-agent-workspaces'
mkdir -p "$expected_root"
workspace_root="$(realpath -m "$SYMPHONY_WORKSPACE_ROOT")"
test "$workspace_root" = "$expected_root"
test "$(id -un)" = 'symphony'
test "$(stat -c '%U' "$workspace_root")" = 'symphony'
test ! -d "$workspace_root/.git"
if env | cut -d= -f1 | grep -q '^AWS_'; then
  echo 'AWS_* variables are prohibited for the Symphony service account' >&2
  exit 1
fi
findmnt --target "$workspace_root"
codex app-server --help >/dev/null
```

`findmnt` 的输出必须由 operator 确认不指向生产数据卷。还要人工确认：该用户没有 AWS/SSM 凭据；`main` branch protection 已启用；Linear 项目和 `agent-ready` 标签已建好；试点范围中没有生产或人工决策工单。

## 4. 启动与停止

将版本化的 `WORKFLOW.md` 传给 Symphony。服务应以该专用用户运行，日志写入宿主机受限目录，并只绑定 loopback 的可选状态页。

```sh
cd /srv/symphony/openai-symphony/elixir
mise exec -- ./bin/symphony /path/to/insight-agent/WORKFLOW.md
```

初始并发固定为 `1`。发现越权命令、凭据暴露、错误领取、不预期的 PR/状态变化时，立即停止服务并将相关 Linear 工单移至 `Needs Human` 或 `Blocked`；保留 workspace 与日志供复盘，不做自动清理。

## 5. 试点评审

每个工单的人工审查包至少含：Linear 工单链接、PR 链接、测试命令与结果、CI 状态、已知风险、是否产生/保留 workspace。连续 10 个工单后，依据 `symphony-pilot.md` 的验收标准决定是否扩并发或扩大范围。
