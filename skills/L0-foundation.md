# L0 — 基础层 (Foundation)

> Claude Code 在本项目的最底层行为约束。所有上层 skill 默认继承本层。

## 代码规范

<!-- TODO: 语言、风格、命名、Lint 配置 -->

## Git 约束

- 提交信息：<格式约定，例如 conventional commits>
- 分支模型：<trunk-based / git-flow>
- 不允许：force push 到主分支、跳过 hooks
- **`main` 受分支保护**：不直推 `main`（直推会被拒）。所有改动走 feature 分支 → 独立 review → push `origin` → PR → CI 绿 → 合入 → 删远程分支。
  单人仓的保护配置基线：required approvals=**0**（独立 Agent review 不等于 GitHub PR approval，也无法自审自批）；必需状态检查选 `ci.yml`；禁止删除 `main`（force push 见上）；保留 admin bypass 作 flaky CI 应急出口；strict "require branches up to date" 暂不开（避免单人迭代徒增 rebase 负担）。

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
- **「默认即隔离」优于「手动隔离」**：本项目 `docker-compose.yml` 不写死 `name:`，工程名回落
  目录 basename → 各 worktree `docker compose up` 零配置自动隔离卷 `<basename>_insight-data`。
  即"危险的事（串库）默认不发生"，而非靠记得建 `.env`。反过来：**权威/生产实例**（拥有真数据）
  须在自己目录 `.env` 显式钉 `COMPOSE_PROJECT_NAME=deep-insight`，保证换目录跑仍复用同卷。
  端口不随目录自动分配，同时起多套才需设 `APP_PORT`（良性失败：绑定报错、立即可见、不伤数据）。
- **认知陷阱备忘**：`COMPOSE_PROJECT_NAME` / `APP_PORT` 必须放 compose 目录的 `.env`，不是
  `.env.local`（后者是 `env_file:`，只注入容器内部环境，compose 解析工程名/插值时不读）。

## 文件操作约定

<!-- TODO: 什么文件可改、什么文件需复核 -->
