# 部署与运维指南（M4 Launch）

> 自托管**单实例** Docker 部署：`app`（Web + Job Runner）+ `cron`（容器内 supercronic 调度）+ 持久卷。
> 设计见 `docs/plan/architecture.md`「部署」；本文是上线/运维操作手册。

## 1. 架构与组件

| 组件 | 角色 |
|---|---|
| `app` 容器 | Next.js standalone（`server.js`，:3000）+ Job Runner（采集/分析/校验/报告在进程内跑，非 serverless、无超时） |
| `cron` 容器 | 复用同镜像跑 supercronic，按 `ops/crontab` 每 6h `POST /api/cron`（经 `ops/trigger.mjs`，Node fetch 免 curl） |
| 持久卷 `insight-data` | 挂 `/data`：SQLite 库（`insight.db`，WAL+FTS5）+ 报告正文 FS（`/data/reports`）+ 原文归档（`/data/raw`） |
| 镜像 | slim 运行层、**非 root**（uid 1001）、tag 锁定 `deep-insight:0.1.0`（不用 latest）；supercronic 校验和锁版本 + 架构 |

数据流：`cron → POST /api/cron →` Job Runner `→` 采集 → 分析 → 校验 → report-gen → 落库（Run/成本/审计）。

## 2. 首次上线

```bash
cp .env.example .env.local        # 按 §3 填全（尤其 CRON_SECRET、中转站 Opus 模型）
# Apple Silicon / arm64 主机构建需指定（默认 amd64；supercronic 校验和按架构锁定）
TARGETARCH=arm64 docker compose up -d --build      # x86_64 主机省略 TARGETARCH
docker compose ps                 # 期望 app/cron 均 healthy / running
curl -fsS http://127.0.0.1:3000/api/health         # {"status":"ok","reports":N}
```

首跑库为空时 `getEffectiveSources` 会自举播种默认 Topic/Source；首轮 cron（每 6h）或手动触发后才有报告。手动触发一轮：

```bash
curl -fsS -X POST http://127.0.0.1:3000/api/cron -H "authorization: Bearer $CRON_SECRET"
```

反向代理（Nginx/Caddy）转发到 `:3000`，对外加 TLS；`/api/cron` 不必对公网暴露（容器网络内 `cron→app` 即可）。

## 3. 环境变量速查

| 变量 | 必需 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | 模型调用凭据 |
| `ANTHROPIC_BASE_URL` | 中转站时 | 第三方中转站地址；直连 Anthropic 留空 |
| `ANALYZER_MODEL` | 中转站时 ✅ | **Opus-only 中转站必须显式设 Opus**（如 `claude-opus-4-6`），否则打到默认 sonnet → analyze 失败。须 ≠ validator |
| `VALIDATOR_MODEL` | 否 | 默认 `claude-opus-4-7`；**必须独立于 analyzer**（同源偏差约束，相同则启动报错） |
| `VALIDATOR_THINKING` | 中转站建议 | 设 `0` 关校验思考（部分中转站 thinking 计价虚高/不稳） |
| `AUTH_SECRET` | ✅ | NextAuth 密钥，`openssl rand -base64 32` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | 管理员登录（Credentials） |
| `CRON_SECRET` | ✅（定时） | `openssl rand -base64 32`；**未设则 `/api/cron` 返回 503、定时管线不工作** |
| `PIPELINE_WINDOW_HOURS` | 否 | 单轮回看窗口，默认 168（7 天） |
| `ALERT_WEBHOOK` | 否 | Run 失败时 POST 告警（Slack incoming webhook 兼容 `{text}`；通用 webhook 同样可收）；未设则不发、失败仍落 Run + error 日志 |
| `ALERT_TIMEOUT_MS` | 否 | 告警发送超时，默认 5000 |
| `DATA_DIR`/`DB_PATH`/`INSIGHT_CONFIG_PATH` | 容器已设 | 勿在本地 dev 设；Dockerfile 已指向 `/data` 与打包内 `defaults.yaml` |

## 4. ⚠️ 中转站（Opus-only）约束

当前以第三方中转站接入（无直连 `sk-ant-` key）：

- **仅 Opus 可用**（`claude-opus-4-6` / `claude-opus-4-7`），无 Sonnet/Haiku → `ANALYZER_MODEL` 必设 Opus、且 ≠ `VALIDATOR_MODEL`。
- **成本（含校验，实测）**：一轮报告（analyze + validate）≈ **¥14–26**，校验（opus-4-7 逐条一致性）是大头；阈值为 provisional，定稿待重订口径或 Sonnet 降本（见 `docs/verify/dcp-3-readiness-2026-05-28.md` §3）。
- 长输出已走流式、降网关超时；中转站偶发不稳由 120s 超时 + 重试 + analyzeWithSplit 拆批兜底。

## 5. 运行与监控

- **健康**：`GET /api/health`（查一次库、不触发 LLM）；`docker compose ps` 看 healthy；`docker compose logs -f app|cron`。
- **Run 记录**：每次采集/分析/校验/报告经 Job Runner 落一条 Run（单调时钟耗时 + 失败捕获 + 成本透传）；`audit_log` 记关键动作；成本计量按模型累计。
- **报告**：Web `/reports`（报告库）/ 今日 Brief / 看板 / `/settings`；登录 `/login`。
- **cron 是否在跑**：`docker compose logs cron` 应见每 6h 一行 `POST .../api/cron → HTTP 200`。
- **失败告警**：任一 Run（采集/分析/校验/报告）失败时，若配置 `ALERT_WEBHOOK` 则 fire-and-forget POST 一条告警（Slack 兼容 `{text}` + kind/runId/error 结构化字段）；告警发送本身永不连累管线（超时 + 全捕获）。未配置时失败仍落 Run + error 日志，从 `docker compose logs app` 可见。

## 6. 数据与备份/恢复

所有状态在持久卷 `insight-data`（`/data`）。备份前建议先 `docker compose stop app cron` 静默写入（SQLite WAL），再打包：

```bash
docker run --rm -v deep-insight_insight-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/insight-data-$(date +%F).tgz -C /data .
# 恢复：tar xzf 到同名卷后 docker compose up -d
```

> 卷名默认 `<compose项目名>_insight-data`（项目名 `deep-insight`）。`docker volume ls` 确认。
> 第三方原文全文存在 `/data/raw`，按「不复制全文存储」原则**不入仓**，仅随卷备份。

## 7. 故障排查

| 症状 | 原因 / 处置 |
|---|---|
| `cron` 容器起不来 | app 未 healthy（`depends_on: service_healthy`）；查 app 健康探针；**镜像 slim 无 curl，探针/触发用 Node fetch**（compose 与 Dockerfile 已一致） |
| `cron` 容器**无健康状态**（`ps` 不显示 healthy） | 正常——cron 跑 supercronic、非 Web 服务，已在 compose **禁用**继承自镜像的 Web 探针（否则会误报 unhealthy）。判活看 `docker compose logs cron` |
| `/api/cron` 返回 503 | `CRON_SECRET` 未配置 → 定时禁用；填 `.env.local` 重起 |
| `/api/cron` 返回 401 | Bearer 与 `CRON_SECRET` 不符 |
| analyze 报错 / 拒答 | 中转站打到 sonnet（未设 `ANALYZER_MODEL=opus-*`）；敏感内容拒答由 analyzeWithSplit 隔离丢弃、不应整批失败 |
| 启动即报「校验模型必须独立于分析模型」 | `ANALYZER_MODEL == VALIDATOR_MODEL`，改成不同 Opus 版本 |
| arm64 主机 cron crash | 构建未传 `TARGETARCH=arm64` → supercronic 架构不符；重建镜像 |
| 报告生成慢 / 偶发超时 | 中转站不稳；已有 120s 超时 + 重试 + 拆批兜底；持续不稳考虑更稳接入 |

## 8. 升级

改 `package.json` version → 同步 compose `image: deep-insight:<ver>` → `docker compose up -d --build`。CI（`.github/workflows/ci.yml`）：typecheck → vitest → next build → docker build；Dependabot 管依赖/Actions/镜像。

## 9. 冒烟验证记录

- **2026-05-29 · 本地 `docker compose build && up --wait`（arm64）：✅ 通过**
  - 镜像构建成功（`deep-insight:0.1.0`，482MB）；`up --wait` 退出 0。
  - `app` **Up (healthy)** · `GET /api/health` → `{"status":"ok","reports":0}` · `/login` → HTTP 200。
  - `cron` Up（supercronic 运行、0 错误）。
  - 期间修复两处上线阻断（均经本测试验证）：① compose 健康探针 `curl`→Node fetch（slim 无 curl，否则 app 永不 healthy）；② `cron` 服务禁用继承自镜像的 Web 探针（cron 非 Web 服务，否则 fetch :3000 永远失败、误报 unhealthy、`--wait`/CI 失败）。
