# Insight Agent

<!-- TODO: 项目说明 -->

## 目录结构

```
insight-agent/
├── docs/        # IPD 文档（concept / plan / develop / verify）
├── skills/      # Claude Code 行为约束（L0–L3）
├── src/         # 应用代码
└── tests/       # 单元 / 集成 / e2e 测试
```

详见 `CLAUDE.md`。

## 本地开发

```bash
cp .env.example .env.local   # 填 ANTHROPIC_API_KEY / AUTH_SECRET / ADMIN_*
npm install
npm run seed                 # 播种默认 Topic/Source 到 .data/insight.db
npm run dev                  # http://localhost:3000
```

## 部署（自托管 Docker 单实例）

```bash
cp .env.example .env.local   # 另需填 CRON_SECRET（openssl rand -base64 32）
docker compose up -d --build
```

- `app` 服务跑 Web + Job Runner，SQLite / 报告正文落持久卷 `insight-data:/data`。
- `cron` 服务复用同镜像跑 supercronic，按 `ops/crontab` 定时 `POST /api/cron`（每 6h 一轮完整管线）。
- 健康探针 `GET /api/health`；镜像 tag 锁定（base 锁 patch、supercronic 锁版本 + SHA1）。
- 经第三方中转站时 `.env.local` 需设 `VALIDATOR_THINKING=0`（见 `docs/practice-log.md`）。

CI（`.github/workflows/ci.yml`）：typecheck → vitest → next build → docker build；Dependabot 管依赖 / Actions / 镜像升级。
