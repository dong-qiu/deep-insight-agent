# L0 — 基础层 (Foundation)

> Claude Code 在本项目的最底层行为约束。所有上层 skill 默认继承本层。

## 代码规范

<!-- TODO: 语言、风格、命名、Lint 配置 -->

## Git 约束

- 提交信息：<格式约定，例如 conventional commits>
- 分支模型：<trunk-based / git-flow>
- 不允许：force push 到主分支、跳过 hooks

## 安全边界

- 禁止提交：`.env`、密钥、token、个人数据
- 禁止访问：<列出禁区路径或资源>
- 外部调用：所有第三方 API 调用必须走 `src/lib/sources/` 适配层

## 并发隔离（多 worktree / 多环境）

> 同源教训二次踩坑后固化（见 `docs/practice-log.md` 2026-06-07、2026-06-06 两条）。

- **能用配置/路径钉死的隔离，永远别留给纪律。** "约好只在一个 worktree 跑 X" 必然会忘——
  改成结构性隔离。已踩过两次：① `.env.local` 没钉绝对 `DB_PATH` → worktree 读空库；
  ② `docker-compose.yml` `name:` 写死 → 多 worktree 共用工程/卷/端口。
- **隔离与共享解耦**：先让环境天然隔离（compose 工程名按 worktree 分、各自独立卷/端口），
  要共享数据再单独走"快照/外部卷"，不靠"同名硬绑"顺带实现共享。
- **共享"配方"不共享"live 库"**：跨分支读写同一 SQLite 库 = 写锁竞争 + 迁移漂移。
  正确做法是共享不可变快照 / seed（`npm run db:snapshot` / `db:restore`），各 worktree
  起独立库、从同一起点恢复后各自漂移。真要并发多写共享状态才上 Postgres，绝不挂同一卷。
- **环境隔离是特性不是缺陷**（12-factor dev/prod parity）：一个分支的迁移/脏数据不得污染
  另一个分支的验证。要的恰恰是"互不一致"。数据是产物、不是真相来源（真相 = 代码 + seed/迁移）。
- **认知陷阱备忘**：`COMPOSE_PROJECT_NAME` 必须放 compose 目录的 `.env`，不是 `.env.local`
  （后者是 `env_file:`，只注入容器内部环境，compose 解析工程名时不读）。

## 文件操作约定

<!-- TODO: 什么文件可改、什么文件需复核 -->
