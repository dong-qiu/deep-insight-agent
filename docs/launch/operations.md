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

首跑库为空时 `getEffectiveSources` 会自举播种默认 Topic/Source；首轮 cron（每 6h）或手动触发后才有报告。**冷启动**（topic 尚无任何报告）自动产出**首版综述 `initial_digest`**（更宽回看窗口 + 更多条），其后该主题回落到常规 brief/deep_dive——新增主题同理。手动触发一轮：

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
| `INITIAL_DIGEST_WINDOW_HOURS` / `INITIAL_DIGEST_ITEMS` | 否 | 冷启动首版综述的窗口/条数，默认 720（30 天）/ 25 |
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

**手动**：改 `package.json` version → 同步 compose `image: deep-insight:<ver>` → `docker compose up -d --build`。CI（`.github/workflows/ci.yml`）：typecheck → vitest → next build → docker build；Dependabot 管依赖/Actions/镜像。

**CD（自动部署 · `.github/workflows/deploy.yml`）**：**手动触发**（Actions → Deploy → Run）或**推送 `v*` tag**（刻意发布）；**不**在 push main 自动部署（避免每次合并即上线）。流程 = SSH 到服务器 → `git pull --ff-only`（跟踪 main）→ 按服务器架构 `docker compose up -d --wait --build` → `image prune`。`up --wait` 不健康即非零退出 → 部署标红（健康门）。

- **必需 secrets**（仓库 Settings → Secrets）：`DEPLOY_HOST` · `DEPLOY_USER` · `DEPLOY_SSH_KEY`（部署用户私钥）· `DEPLOY_KNOWN_HOSTS`（`ssh-keyscan -H 主机` 生成，固定主机公钥防中间人）· `DEPLOY_PATH`（服务器上仓库 clone 路径）·（可选 `DEPLOY_SSH_PORT`，默认 22）。
- **服务器前置**：装 docker + compose；仓库已 clone 在 `DEPLOY_PATH` 且 remote 跟踪 main；**`.env.local` 已置于服务器**（gitignored、operator 手动放，CD 不碰密钥）；部署用户在 docker 组。
- **语义**：tag/手动只是"现在部署当前 main HEAD"。需精确按 tag 部署可改远端为 `git fetch --tags && git checkout <tag>`。
- **加固**：在 Settings → Environments → `production` 配"必需审批/保护规则"，给生产部署再上一道人闸。

## 9. 冒烟验证记录

- **2026-05-29 · 本地 `docker compose build && up --wait`（arm64）：✅ 通过**
  - 镜像构建成功（`deep-insight:0.1.0`，482MB）；`up --wait` 退出 0。
  - `app` **Up (healthy)** · `GET /api/health` → `{"status":"ok","reports":0}` · `/login` → HTTP 200。
  - `cron` Up（supercronic 运行、0 错误）。
  - 期间修复两处上线阻断（均经本测试验证）：① compose 健康探针 `curl`→Node fetch（slim 无 curl，否则 app 永不 healthy）；② `cron` 服务禁用继承自镜像的 Web 探针（cron 非 Web 服务，否则 fetch :3000 永远失败、误报 unhealthy、`--wait`/CI 失败）。
- **2026-05-30 · 上线前鉴权门容器烟雾（arm64）：✅ 通过**
  - 修：上线前发现 `/reports`/`/reports/[id]`/`/settings`/`GET /api/reports` 不在 middleware matcher 内 → 公网即全公开。统一鉴权门：matcher 改"除静态+NextAuth 外全匹配"+ 白名单 `/login`·`/api/health`·`/api/cron`（Bearer 在 handler）；其余无 session：页面 302→`/login?from=...`，/api→401 JSON。
  - 真容器逐路径验：`/api/health` 200 · `/login` 200 · `/` 307→`/login?from=%2F` · `/reports` 307 · `/settings` 307 · `/api/reports` 401 JSON · `/api/cron` 503（无 Bearer，handler 自挡）。全部如设计。
- **2026-05-31 · 端到端管线 + 治本一例：✅ 通过**
  - 触发 `POST /api/cron` 跑全管线两轮，验证容器内 standalone build 完整、卷写、relay 联通、auth gate。**Run 1（冷启动 initial_digest）**：swe `rep_3693300f` ✅ 65 洞察 / 151 引用；security `rep_50892218` 🟡 0 洞察。耗时 42 min、$2.50。
  - **诊断 security 0 洞察 → 抓出 `analyzeWithSplit` 真 bug**：日志显示 16+ 次"丢弃"全是 `Connection error.`（SDK 网络错误、非模型拒答），中转站 security 运行窗口塌掉；原 `analyzeWithSplit` 用一个 `catch (e)` 无差别捕获，把网络错误也当拒答递归拆批→丢光 → 写 `no_significant_event=true`。
  - **治本**：新增 `src/lib/runtime/errors.ts` 的 `isTransientApiError`——基于 SDK 类型（`APIConnectionError`/`RateLimitError`/`InternalServerError`）+ 兜底关键词（Connection error / Request timed out / ETIMEDOUT 等）。`analyzeWithSplit` catch 先调它；**瞬时基础设施错误抛上**（runJob 标 failed + 告警钩子），仅模型层错误（refusal/解析失败/max_tokens）才拆批。
  - **Run 2（暖启动 brief，复现 + 验证修复）**：中转站仍抽风 → 两主题双双 `failed: Request timed out`（如实暴露根因，**不再静默 0 洞察**）。耗时 14 min、**$0.58**（快速失败、不再耗费拆批分析钱）。修复**端到端坐实**。
  - **Run 3（暖启动 brief，relay 健康，端到端 happy path）**：swe `rep_54ed154e` 45 洞察 / 110 引用；security `rep_b91964bd` 4 洞察 / 12 引用。耗时 34 min、**$11.40**（validator $8.15 仍是大头）。
  - **Run 3 副产品 · 可溯源链路在真实运行中首次端到端坐实**：抽查 security #1（"MITRE ATLAS v5.1.0–v5.6.0 综览"，statement 含多个具体技术/缓解名、报告渲染显示 `引用（1）`），逐层溯源 → DB 实际挂了 **4 条 citation 跨 3 个 ATLAS release**；validator（独立 Opus-4-7）将其中 3 条判 `blocked`（`exaggeration` ×2、`out_of_context` ×1），仅 1 条判 `flagged uncertain`；`report-gen.selectInsights` 白名单据此剔除 3 条 blocked、保留 1 条 flagged → 报告渲染如实只列 1 条 quote + statement 自动带 `〔待核实〕`标记。**结论**：构造性可达保证（validator 一致性闸门 → 白名单 → 100% 可达发布）在真实运行洞察上首次坐实，不止对 dogfood 45 条管用——validator 在生产路径上独立抓出了 analyzer rule 5（不得放大）的违规，把"结论合并 v5.1.0–v5.3.0 内容、文本却跨度到 v5.6.0"这种放大行为屏蔽掉，正是 DCP-3 §2 论证的"发布层 100% by construction"实例。

## 10. 在 Oracle Cloud Always-Free（ARM）上部署（免费选项）

Oracle 的 **Always Free** ARM Ampere A1 实例（永久免费、最高 4 OCPU / 24GB RAM + 块存储）是本应用唯一契合的"纯免费"落点：它是**真 VM**，整套 `docker compose`（app + cron sidecar + 命名卷）原样跑，无须 PaaS 那样的特殊卷配置。本镜像**已支持 arm64**（§9 冒烟测试即 arm64）。

> ⚠️ 免费主机省的是"机器钱"，**省不掉模型调用钱**（每轮管线走中转站 Opus ≈ ¥14–26，每 6h 一轮，见 §4）。

**与通用步骤的关系**：§2 首次上线 / §6 备份 / §8 CD（`deploy.yml`，`DEPLOY_HOST` 填公网 IP）全部适用；下面只列 **Oracle/ARM 特有**注意点。

1. **开实例**：选 **Ampere A1（arm64）· Always Free** shape + Ubuntu LTS。ARM 免费容量常被抢光——多试几次 / 换可用域（AD）/ 换区域。需绑卡做身份验证（不扣费）。
2. **网络放行（Oracle 双层防火墙，经典坑）**：要同时开两处，否则外部访问不通——
   - 云侧 **Security List / NSG**：放行入站 **80 / 443**（给反代）；
   - 实例内防火墙：Oracle 的 Ubuntu 镜像默认 iptables 收紧，需 `sudo ufw allow 80,443/tcp`（或改 iptables）。
   - **不要**对公网开 3000；外部只走反代的 80/443。
3. **装 Docker + 部署**：同 §2，但构建必传架构（compose 默认 `amd64`）：
   ```bash
   export TARGETARCH=arm64
   docker compose up -d --wait --wait-timeout 180 --build
   ```
   Ampere RAM 充足，`next build` + better-sqlite3 编译无内存压力（不像 1GB 微型机需加 swap）。
4. **持久化（自动）**：这是 VM，Docker 命名卷 `insight-data` 落在持久启动盘 → 重启 / 重部署 / `up` 都在，**无需** PaaS 式持久卷设置。（可选：挂独立块卷再把 `/var/lib/docker/volumes` 或 compose 卷指过去，非必需。）
5. **反代 + TLS**：VM 无自带域名 → 自备域名、A 记录指向实例**公网 IP**，按 §2 反代说明上 Caddy（自动证书）。
6. **CD**：`deploy.yml` 直接可用——`DEPLOY_HOST` = 公网 IP；workflow 内 `TARGETARCH=$(uname -m …)` 会在 ARM 上自动解析为 `arm64`，无需额外配置。
