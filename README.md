# Insight Agent

面向行业情报的**多源洞察分析** agent：按主题（如「AI 时代的软件工程」「AI 时代的安全」）定时采集多源公开内容（RSS / arXiv / 播客 show notes 等），提炼**可溯源**的结构化洞察，经独立校验器把关后生成今日 Brief / 深挖报告。

核心保证：**发布报告里的每条引用都逐字可达原文**（`validator` 确定性可达性校验 + `report-gen` 白名单闸门，构造即成立）；幻觉率人评固化 0/45；引用一致性双层校验、不退化为只过可达性。

> IPD 阶段：M3 Verify 已收口、DCP-3 有条件通过（2026-05-29），进入 **M4 Launch**。决策日志见 `docs/plan/roadmap.md`。

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
cp .env.example .env.local   # 另需填 CRON_SECRET（openssl rand -base64 32）；中转站需设 Opus 模型，见下
TARGETARCH=arm64 docker compose up -d --build   # Apple Silicon/arm64；x86_64 省略 TARGETARCH
```

**完整部署与运维手册**（环境变量速查 / 中转站 Opus 约束 / 监控 / 备份恢复 / 故障排查）见 **`docs/launch/operations.md`**。

- `app` 服务跑 Web + Job Runner，SQLite / 报告正文落持久卷 `insight-data:/data`。
- `cron` 服务复用同镜像跑 supercronic，按 `ops/crontab` 定时 `POST /api/cron`（每 6h 一轮完整管线）。
- 健康探针 `GET /api/health`；镜像 tag 锁定（base 锁 patch、supercronic 锁版本 + SHA1）。
- 经第三方中转站时 `.env.local` 需设 `VALIDATOR_THINKING=0`（见 `docs/practice-log.md`）。

CI（`.github/workflows/ci.yml`）：typecheck → vitest → next build → docker build；Dependabot 管依赖 / Actions / 镜像升级。
