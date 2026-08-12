# OpenAI Symphony 试点运行手册

> 仅用于非生产宿主机。参见 `docs/plan/specs/symphony-pilot.md` 与根目录 `WORKFLOW.md`。

## 0. 运行前边界

- 不在生产 EC2、开发者主 checkout、共享 SQLite 卷或能访问生产 AWS/SSM 的机器上运行。
- 使用专用 OS 用户；该用户不拥有 `~/.aws`、生产 `.env.local`、生产数据库、SSH 生产 key 或部署凭据。
- GitHub tracker token、Git 凭据和 Codex 登录状态只保存于该用户的宿主机密钥管理/环境配置，绝不写入仓库或 workspace。
- `main` 必须受保护，并要求 PR 与 CI；Symphony 无自动合并或部署权限。
- 服务管理器只注入试点必需环境变量，且显式清除 `AWS_*`、`AWS_PROFILE`、`DATABASE_URL`、`DB_PATH`、`DISPATCH_WORKER_SECRET` 及所有生产应用变量。

## 1. GitHub Issues 控制面

在 `dong-qiu/deep-insight-agent` 创建以下标签：

`agent-ready`、`agent-working`、`agent-human-review`、`agent-needs-human`、`agent-blocked`。

GitHub adapter 只将 `open` Issue 视为活跃、`closed` Issue 视为终态；上述标签是试点工作流的唯一状态来源。只有验收标准、风险范围和完成定义均明确的低风险开放 Issue 才由人工添加 `agent-ready`。不要把生产故障、数据库迁移、人工 dogfood 标注或产品/架构决策标为 `agent-ready`。

`agent-ready` 表示可派发；controller 在启动 Codex 前先添加 `agent-working`、再移除 `agent-ready`。Codex 不得修改这两个认领标签。`agent-human-review`、`agent-needs-human` 与 `agent-blocked` 是停止标签，任一存在都会终止续跑并阻止运行标签残留的 Issue 被再次派发。交接时 Codex 添加 `agent-human-review`；人类确认会话已停止后移除 `agent-working`，需要返工时移除交接标签并重新添加 `agent-ready`。阻塞时 Codex 添加 `agent-needs-human` 或 `agent-blocked`，仍由人类解除运行标签。人类合入后关闭 Issue。

停止标签只能由 Codex 添加、不能移除；解除交接/阻塞并重新派发始终是人工操作。服务必须通过 `flock` 对 `symphony-github-dong-qiu--deep-insight-agent` 取得排他锁；未取得锁即退出，禁止同一仓库存在两个 controller。

## 2. 宿主机环境

安装 OpenAI Symphony 的参考实现所需 runtime，以及 Codex app-server、Git、Node 20 与 npm 10。OpenAI 的参考实现使用 Elixir/Erlang，并以 `mix setup` / `mix build` 后运行 `bin/symphony`；版本和安装方式以其 README 为准。

由服务管理器或宿主机密钥管理将 `SYMPHONY_GITHUB_TOKEN` 与 `SYMPHONY_WORKSPACE_ROOT` 注入专用服务账号；不要通过交互式 `export` 设置 token。`SYMPHONY_WORKSPACE_ROOT` 固定为 `/srv/symphony/insight-agent-workspaces`。

不要在 shell history、systemd unit 文件、`WORKFLOW.md` 或仓库 `.env` 中写 token。`SYMPHONY_GITHUB_TOKEN` 必须是仅限 `dong-qiu/deep-insight-agent` 的 fine-grained tracker token，权限仅为 Pull requests read/write、Issues read/write、Metadata read；不得授予 Contents、Actions、Environments、Administration、Secrets、Webhooks、Deployments 或其他仓库。保护规则必须拒绝直接更新 `main`，并且 Symphony 的 bot/deploy key 无 bypass。

Symphony 会从 Codex 子进程移除 `SYMPHONY_GITHUB_TOKEN`，所以 clone/push 不能依赖该环境变量。另配置一个仅对 `symphony` 用户可读的 Git credential helper，由宿主机密钥管理器提供独立的 repository-scoped deploy key 或非管理员 bot 身份；不得把 token 写入远程 URL、`.git/config`、workspace、shell history 或服务日志。该 helper 只允许 `https://github.com/dong-qiu/deep-insight-agent.git`。

## 3. Preflight

在服务管理器已注入环境、且以专用 `symphony` OS 用户运行的 preflight 中逐项确认：

```sh
test -n "$SYMPHONY_GITHUB_TOKEN"
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
git ls-remote https://github.com/dong-qiu/deep-insight-agent.git refs/heads/main >/dev/null
git credential fill <<'EOF' | grep -q '^password='
protocol=https
host=github.com
path=dong-qiu/deep-insight-agent.git
EOF
```

`findmnt` 的输出必须由 operator 确认不指向生产数据卷。还要人工确认：该用户没有 AWS/SSM 凭据；`main` branch protection 已启用；五个 GitHub 试点标签已建好；tracker token 与 Git credential helper 均无法访问其他仓库；试点范围中没有生产或人工决策 Issue。

## 4. 启动与停止

将版本化的 `WORKFLOW.md` 传给 Symphony。服务应以该专用用户运行，日志写入宿主机受限目录，并只绑定 loopback 的可选状态页。

```sh
cd /srv/symphony/openai-symphony/elixir
exec 9>/srv/symphony/symphony-github-dong-qiu--deep-insight-agent.lock
flock -n 9 || { echo 'another Symphony controller owns this repository' >&2; exit 1; }
mise exec -- ./bin/symphony /path/to/insight-agent/WORKFLOW.md
```

初始并发固定为 `1`。发现越权命令、凭据暴露、错误领取、不预期的 PR/标签变化时，立即停止服务并在相关 GitHub Issue 留下说明，移除 `agent-ready`、添加 `agent-needs-human` 或 `agent-blocked`；保留 workspace 与日志供复盘，不做自动清理。

## 5. 试点评审

每个 Issue 的人工审查包至少含：Issue 链接、PR 链接、测试命令与结果、CI 状态、已知风险、是否产生/保留 workspace。连续 10 个 Issue 后，依据 `symphony-pilot.md` 的验收标准决定是否扩并发或扩大范围。
