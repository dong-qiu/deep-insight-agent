# 部署与运维指南（M4 Launch）

> 自托管**单实例** Docker 部署：`app`（Web + Job Runner）+ `cron`（容器内 supercronic 调度）+ 持久卷。
> 设计见 `docs/plan/architecture.md`「部署」；本文是上线/运维操作手册。

## 完整性锚定维护

完整性维护不依赖报告生成调度，但 P1c 由 `INTEGRITY_ANCHOR_ENABLED=true` 显式启用。
默认关闭时，容器内 `ops/crontab` 每 5 分钟调用一次
`/api/cron?mode=integrity` 会成功记录为跳过；P0 的引用校验与报告发布照常运行，且不会
产生或声明锚定证据。只有完成 INSI-25 的 Object Lock、KMS、最小 IAM、保留期限与 on-call
准入后才能启用。启用后，容器内 `ops/crontab` 每 5 分钟调用一次
`/api/cron?mode=integrity`：UTC 02:00 固化前一日 Merkle root，02:15 若 root
缺失即写入高优先级审计告警，其余执行会恢复已写入锚点的 SQLite 投影，并以最多
两个并发 worker 对每个已发布 artifact 每 24 小时重校验一次。任何非 `pass`
结果只写入脱敏的版本、终态、失败步骤与 hash 前缀，并在五分钟调度窗口内告警；
它绝不阻塞或下线已提交报告。

管理员可按需调用 `POST /api/admin/integrity-checks/{artifactId}/{version}` 重校验一个
版本。该 endpoint 不返回 artifact 路径、Object Store locator 或正文；校验身份只需要
bucket 的读取权限，不加载签名私钥。

启用锚定时，除 bucket、密钥 ID 与私钥外，必须显式配置且保持为未来时间的
`INTEGRITY_REPORT_READABLE_UNTIL`、`INTEGRITY_REPORT_ARCHIVE_UNTIL` 与
`INTEGRITY_ARTIFACT_RETAIN_UNTIL`。系统以这三个期限、artifact retain 期限和
签发后 100 天的最大值保存验证材料；密钥与撤销记录是 append-only 历史材料，
不得删除或覆写。

## 1. 架构与组件

| 组件 | 角色 |
|---|---|
| `app` 容器 | Next.js standalone（`server.js`，:3000）+ Job Runner（worker 经内部端点在此执行分析/校验/报告，非 serverless、无超时） |
| `cron` 容器 | 复用同镜像跑 supercronic，按 `ops/crontab` 每 6h `POST /api/cron`（经 `ops/trigger.mjs`，Node HTTP 免 curl） |
| `generation-dispatch-worker` 容器 | 持续领取日报与 Deep Dive 的 durable dispatch；持有 lease/fencing 后才启动主题流水线，崩溃后可接管重试。收到 `SIGTERM` 时先进入 drain：不再领取新任务、等待在途内部请求完成，最长一个 lease 窗口后退出并由 lease recovery 接管。 |
| 持久卷 `insight-data` | 挂 `/data`：SQLite 库（`insight.db`，WAL+FTS5）+ 报告正文 FS（`/data/reports`）+ 原文归档（`/data/raw`） |
| 镜像 | slim 运行层、**非 root**（uid 1001）、tag 锁定 `deep-insight:0.1.0`（不用 latest）；supercronic 校验和锁版本 + 架构 |

数据流：`cron → POST /api/cron →` 采集 + 每主题 durable dispatch `→ generation-dispatch-worker →` Job Runner → 分析 → 校验 → report-gen → 落库（Run/成本/溯源审计）。

## 2. 首次上线

```bash
cp .env.example .env.local        # 按 §3 填全（尤其 CRON_SECRET、中转站 Opus 模型）
# Apple Silicon / arm64 主机构建需指定（默认 amd64；supercronic 校验和按架构锁定）
TARGETARCH=arm64 docker compose up -d --build      # x86_64 主机省略 TARGETARCH
docker compose ps                 # app、generation-dispatch-worker 应为 healthy；cron 应为 running
curl -fsS http://127.0.0.1:3000/api/health         # {"status":"ok","reports":N}
```

`/api/health` 仅代表 Web/app 与数据库的基础存活，**不代表**生成队列已被消费。
`generation-dispatch-worker` 的健康检查会读取内部 queue-age readiness：最老 queued 或
过期 claimed dispatch 超过 5 分钟会发送告警，超过 15 分钟会标为 `unhealthy`。部署、扩缩容
或手动停止 worker 时，Compose 会给予它 2 分 15 秒 drain 窗口；不要用 `kill -9` 代替正常停止。

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
| `VALIDATOR_BATCH` | 否 | 一致性判定**按源归并**（同一源被多条结论引用时，源文只发一遍、一次调用逐条独立判 → token 从 ~K×源文砍到 ~1×源文，成本最大杠杆）。默认开；`0` 回退逐条判定（精度回归排查 / 怀疑批量串扰时的运维开关）。判定语义与逐条一致、缓存共享 |
| `CONSISTENCY_BATCH_MAX` | 否 | 单次批量调用最多判几条结论，默认 8。超出拆多次调用（源文各发一遍，仍远省于逐条）。调小=更稳的输出/更高精度但省得少，调大=更省但单调用输出更长、批内判定数更多 |
| `AUTH_SECRET` | ✅ | NextAuth 密钥，`openssl rand -base64 32` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | **内置管理员**（bootstrap，role=admin、全权、不入库、不可删/锁死）。受邀的其他账号在**设置页 → 用户/访问**里增删（存 `app_user` 表、密码 scrypt 哈希，缺省 role=viewer——只读 Brief/报告/主题，不可进配置/管理、不可触发烧钱端点）。对外分享只需建 viewer 账号、把邮箱+密码发对方。鉴权拆 runtime-safe `auth.config.ts`（middleware 读 JWT 角色）/ Node `auth.ts`（查库验密码）；自托管 middleware 显式运行在 Node.js runtime。 |
| `CRON_SECRET` | ✅（定时） | `openssl rand -base64 32`；**未设则 `/api/cron` 返回 503、定时管线不工作** |
| `DISPATCH_WORKER_SECRET` | ✅（P0a） | `openssl rand -base64 32`，且不得复用 `AUTH_SECRET`；只供 compose 内 `generation-dispatch-worker` 调用内部 dispatch / health 接口。缺失时 Deep Dive dispatch fail-closed。 |
| `PROVENANCE_IDEMPOTENCY_SECRET` | 建议 | Deep Dive `Idempotency-Key` 的 HMAC 专用密钥；未设时暂回退 `AUTH_SECRET`，上线后应独立配置以缩小轮换影响面。 |
| `PIPELINE_WINDOW_HOURS` | 否 | 单轮回看窗口，默认 168（7 天） |
| `INITIAL_DIGEST_WINDOW_HOURS` / `INITIAL_DIGEST_ITEMS` | 否 | 冷启动首版综述的窗口/条数，默认 720（30 天）/ 25 |
| `DEEP_DIVE_WINDOW_HOURS` / `DEEP_DIVE_ITEMS` | 否 | 用户触发主题深挖（C-1，`POST /api/topics/[id]/deep-dive`）的窗口/条数，默认 **2160（90 天，对齐 spec / ADR-0004）** / 25。成本由条数封顶、不随窗口涨；想缩小回看范围才需调低 |
| `PROMPT_CACHE` | 否 | `0` 关闭 Anthropic prompt caching。**经只写不读的中转站建议设 0**——本 relay 首次定时 eval 实测 `cache r/w 0/17135`（写了付溢价、读 0 无收益）；直连 Anthropic 时不要设（cache read 真省钱）|
| `CONSISTENCY_CACHE` | 否 | 跨批一致性判定缓存（省 relay 抖动重跑 / 报告重生成的重复 Opus 校验）。默认开；`0` 整体关闭（怀疑缓存返回坏判定时的运维开关）。按「校验模型 + prompt 哈希」版本隔离——改模型/prompt 自动失效重判 |
| `CONSISTENCY_CACHE_TTL_DAYS` | 否 | 一致性缓存 TTL 天数，默认 14。过期项视为 miss → 重判（给"重跑可纠错"留出口，首跑偶发错判最多冻结一个 TTL）|
| `PPT_POLISH_CONCURRENCY` | 否 | B 路径 LLM polish 单批并发上限，默认 4（中转站对 14 路 tool_use 流式 36% 截断、限到 4 路降到 14%；详见 practice-log 2026-06-03/04 条）|
| `PPT_POLISH_COST_CAP_USD` | 否 | B 路径累计成本硬上限（默认 0.30）；越线立刻 AbortController.abort() 取消未启动 + in-flight、partial 结果照常 merge 进缓存 |
| `ALERT_WEBHOOK` | 否 | Run 失败时 POST 告警；**按 URL 自动识别渠道**（feishu / ntfy / slack / discord / generic）并翻译 payload（见 §12）。未设则不发、失败仍落 Run + error 日志 |
| `ALERT_CHANNEL` | 否 | 显式指定渠道，覆盖 URL 自动识别（自建 ntfy 用自定义域名时设 `ntfy`）。取值 feishu/ntfy/slack/discord/generic |
| `ALERT_FEISHU_SECRET` | 否 | 飞书群机器人开了「签名校验」时设；自动加 `timestamp + sign`。不开签名则不设 |
| `ALERT_TIMEOUT_MS` | 否 | 告警发送超时，默认 5000 |
| `BRIEF_ACCEPTANCE_WATCH` | 否 | `1`=P0a Brief 验收观察期：每次 Brief 落库后自动核对 report output ref、非空洞察及发布引用白名单；未达标才复用 `ALERT_WEBHOOK` 告警。空刊记为待下一个非空样本，不等同于管线故障；完成验收后关闭。 |
| `COST_LIMIT_DAILY` | 否 | 日成本上限（**USD**）；触顶自动熔断定时管线（跳过剩余 topic）+ 告警。未设 = 不限（见 §14）|
| `COST_LIMIT_MONTHLY` | 否 | 月成本上限（**USD**，自然月 UTC）；同上熔断 + 告警。未设 = 不限 |
| `COST_ALERT_PCT` | 否 | 触顶前的告警阈值百分比，默认 80；任一维度达此比例发一次「接近上限」告警 |
| `TRANSCRIPT_FETCH` | 否 | `1`=对带 `<podcast:transcript>` 的源抓全文转写做分析（ADR-0007）；空/`0`=只用 show notes。生产默认 `1`（gen-env.sh 写入，2026-06-20 上线）。属「生产手动配的运行时配置」，记得持久化进 `.env.local`（见 §8） |
| `DATA_DIR`/`DB_PATH`/`INSIGHT_CONFIG_PATH` | 容器已设 | 勿在本地 dev 设；Dockerfile 已指向 `/data` 与打包内 `defaults.yaml` |

## 4. ⚠️ 中转站（Opus-only）约束

当前以第三方中转站接入（无直连 `sk-ant-` key）：

- **仅 Opus 可用**（`claude-opus-4-6` / `claude-opus-4-7`），无 Sonnet/Haiku → `ANALYZER_MODEL` 必设 Opus、且 ≠ `VALIDATOR_MODEL`。
- **成本（含校验，实测）**：一轮报告（analyze + validate）≈ **¥14–26**，校验（opus-4-7 逐条一致性）是大头；阈值为 provisional，定稿待重订口径或 Sonnet 降本（见 `docs/verify/dcp-3-readiness-2026-05-28.md` §3）。
- 长输出已走流式、降网关超时；中转站偶发不稳由 120s 超时 + 重试 + analyzeWithSplit 拆批兜底。

## 5. 运行与监控

- **健康**：`GET /api/health` 是 app liveness（查一次库、不触发 LLM）；`generation-dispatch-worker` 另有受 secret 保护的 queue-age readiness，二者不可互相替代。`docker compose ps` 应见 app 和 worker healthy；查看 `docker compose logs -f app cron generation-dispatch-worker`。
- **生成调度队列**：在 worker 容器执行 `node --no-warnings /app/ops/generation-dispatch-healthcheck.mjs` 可复现其探针。若其失败，查 worker 日志、`generation_dispatch` / `generation_lease` 的过期记录、SQLite 锁与上游 LLM/网络；不要因 Web `/api/health` 为 200 而忽略该状态。
- **Run 记录**：每次采集/分析/校验/报告经 Job Runner 落一条 Run（单调时钟耗时 + 失败捕获 + 成本透传）；`audit_log` 记关键动作；成本计量按模型累计。
- **报告**：Web `/reports`（报告库）/ 今日 Brief / 看板 / `/settings`；登录 `/login`。
- **cron 是否在跑**：`docker compose logs cron` 应见每 6h 一行 `POST .../api/cron → HTTP 200`。
- **失败告警**：任一 Run（采集/分析/校验/报告）失败时，若配置 `ALERT_WEBHOOK` 则 fire-and-forget POST 一条告警，**按 URL 自动识别渠道**并翻译 payload（feishu/ntfy/slack/discord/generic，见 §12）；告警发送与构造本身永不连累管线（超时 + 全捕获 + 全程 try/catch）。未配置时失败仍落 Run + error 日志，从 `docker compose logs app` 可见。

## 6. 数据与备份/恢复

所有状态在持久卷 `insight-data`（`/data`）：SQLite 库 `insight.db`（WAL+FTS5）、报告正文 `reports/<id>.md|.html`（DB 只存 `body_path`，正文在 FS）、原文归档 `raw/`。

### 6.1 自动备份（默认开，无需配置）

`cron` 服务每日 **18:00 UTC**（管线 17:00 跑完后 1 小时，确保当日 brief 已落库）跑 `ops/backup-db.mjs`：

- 用 **SQLite 在线备份 API**（`db.backup()`，对 app 并发写安全，产出**一致**的单文件，避免 tar 活库拿到半截 WAL）导出 `insight.db`；
- 连同 `reports/` 正文一并落到 `/data/backups/<UTC时间戳>/{insight.db, reports/}`；
- **保留最近 14 份**（`BACKUP_KEEP` 可调），更早自动删除；
- `raw/` 原文默认不备（可重抓、体量大），`BACKUP_INCLUDE_RAW=1` 才纳入。

```bash
# 手动立即备份（容器内）
docker compose exec -T cron node --no-warnings /app/ops/backup-db.mjs
# 查看现有备份
docker compose exec -T cron ls -1 /data/backups
```

**恢复某份备份（当前生产；P0a 前）**（停写 → 覆盖 → 起）：

> P0a generation provenance 上线后，不能再直接执行本段“覆盖 → 起”流程；必须改用 6.1.2 的脱敏重放恢复流程。

```bash
docker compose stop app cron
TS=20260613-180000   # 选定 /data/backups 下的目标时间戳
docker compose run --rm -T cron sh -c "
  rm -f /data/insight.db /data/insight.db-wal /data/insight.db-shm
  cp /data/backups/$TS/insight.db /data/insight.db
  # 仅当该份确有 reports/ 才覆盖（早期/空库的备份可能没拷 reports，避免 rm 后 cp 失败、把现网正文清空）
  if [ -d /data/backups/$TS/reports ]; then rm -rf /data/reports && cp -r /data/backups/$TS/reports /data/reports; fi
"
docker compose up -d
```

> ⚠️ **6.1 的备份落在同一持久卷**：可防 DB 损坏 / 坏迁移 / 误删（点时恢复），**不防整卷丢失**（EBS 卷损坏 / 实例销毁 / 误删卷）。整卷丢失由 6.1.1 的 off-box DR 兜底。

#### 6.1.1 off-box DR —— 每日异地同步到 S3（生产已启用）

在 6.1 同卷备份之上多一层**异地副本**：host cron 每日把 `/data/backups` 同步到 S3。

- **S3 桶**：`deep-insight-backups-<账号ID>`（ap-southeast-1，与 EC2 同区→上传**免流量费**）；阻断公开访问 + 版本控制 + SSE-S3 默认加密 + 生命周期（对象 90 天过期、旧版本 30 天清，限成本）。
- **权限**：EC2 实例角色 `deep-insight-ssm` 加最小内联策略 `s3-dr-backups`（仅本桶 `ListBucket`/`PutObject`/`GetObject`）；**无长期密钥**，走实例角色。
- **调度**：host `/etc/cron.d/deep-insight-dr`，每日 **18:30 UTC**（在 6.1 容器内 18:00 备份之后）`aws s3 sync /var/lib/docker/volumes/deep-insight_insight-data/_data/backups s3://<桶>/ec2/`（不带 `--delete`→S3 留更长历史，由生命周期限 90 天）；日志 `/var/log/deep-insight-dr.log`。
- **一次性搭建**（含建桶 / 改 IAM / 装 awscli / 装 cron）：`ops/aws/setup-dr.sh`（幂等，可重跑）。成本：~分厘/月，详见该脚本头注。

桶名是 `<AWS_NAME>-backups-<账号ID>`（setup-dr.sh 计算）。**DR 现场先查出真实桶名**，免得对着占位符抓瞎：

```bash
# 查真实桶名（按前缀匹配）
BUCKET=$(aws s3 ls | awk '/deep-insight-backups-/{print $3}')
echo "$BUCKET"
# 手动立即异地同步（在 EC2 上跑）
sudo AWS_DEFAULT_REGION=ap-southeast-1 /usr/local/bin/aws s3 sync \
  /var/lib/docker/volumes/deep-insight_insight-data/_data/backups "s3://$BUCKET/ec2/" --no-progress
# 整卷丢失后，从 S3 取回某份到本地，再按 6.1 恢复进新卷
aws s3 sync "s3://$BUCKET/ec2/20260613-105627/" ./restore-20260613-105627/
```

#### 6.1.2 脱敏登记册（P0a 上线前置）

业务 SQLite 备份不是删除/擦除事实的唯一来源：恢复到删除前的备份会重新带回旧实体。因此，P0a 启用删除入口或 provenance
viewer 前，必须完成一个独立于 `*-backups-*` 的登记册部署：S3 bucket
`<AWS_NAME>-redaction-registry-<账号ID>`（`ap-southeast-1`，public access block、versioning、Object Lock Compliance、
**创建 bucket 时设定的 default Compliance retention=100 days**、默认 SSE-KMS），记录只能用 `If-None-Match: *` 条件写入
`records/YYYY/MM/<record_id>.json` 的新对象；稳定 record ID 的 412 表示重试引用既有对象，绝不覆盖为新版本。`effective_at`
为写入成功时刻，应用不传对象级 retention header；
现有 off-box 备份为 90 天，余量用于恢复与时钟偏差。不得把登记册同步回 `/data/backups`、报告目录、Git 或日志。

部署脚本必须创建 bucket 专用 KMS CMK（alias `alias/<AWS_NAME>-redaction-registry`）以及下列互斥角色，并用 IAM policy
simulator / 集成测试验证 deny：

- 应用实例角色：仅 `records/` 的新对象 `PutObject` 与 `kms:GenerateDataKey` / `kms:Encrypt`；没有 `GetObject`、
  `DeleteObject`、`s3:PutObjectRetention`、registry-CMK 的 `kms:Decrypt` 或 Object-Lock bypass。
- 恢复 runner 角色：仅在受控恢复命令中使用，可对本 bucket `ListBucket` / `GetObject`、对 registry-CMK `kms:Decrypt`；不具有
  业务删除权限。
- 到期清理角色：与上述角色分离，只能清理由生命周期/retain-until 判定为到期的对象；不得绕过 Object Lock。

`REDACTION_HMAC_KEY` 与版本固定来自 AWS Secrets Manager `<AWS_NAME>/redaction-hmac/<version>`，不进入 `.env`、镜像、
SQLite、备份或事件。应用与恢复 runner 对指定版本 secret 只有 `secretsmanager:GetSecretValue`，并只能以
`kms:ViaService=secretsmanager.ap-southeast-1.amazonaws.com` 解密该 secret 的 KMS key；清理角色没有这两项权限。CMK 和 HMAC
旧版本须保留到最后一条引用记录的 retain-until 后。删除操作的顺序是“在内存生成 HMAC 并校验 canonical schema → 以稳定 record ID 条件写 registry → SQLite 原子写
redaction 及业务 tombstone”；任一步失败均 fail-closed。若 registry 写入成功但 SQLite 写失败，保留不可变孤儿记录，重试复用相同
record ID。实现会在外部条件写前先在 `provenance_redaction_request` 保存同一份 envelope 密文和对象 key；因此中断后的重试不会
重新加密、改写对象或改变 `effective_at`。业务删除/audit 必须作为 registry 成功后本地事务的一部分执行。

当前首个受控入口为 `POST /api/admin/reports/{report_id}/redaction`，仅 admin 可用；body 必须提供长度 8–128 的 ASCII
`deletion_request_id`、小写下划线 `reason_code` 与未来 UTC `expiry_at`。成功后报告状态改为 `deleted`，并同步撤下
`report_index`、FTS 与 PPT 派生缓存；正文文件不在请求路径中物理删除。缺少 registry 配置、AWS/KMS 失败或签名/条件写异常均返回
`503 redaction_registry_unavailable`，原报告保持发布状态。

仓库提供 `ops/aws/setup-redaction-registry.sh`：默认 `--check`，只读核验 bucket/KMS/Object-Lock；只有安全管理员预先配置
`REDACTION_HMAC_SECRET_ARN`、`REDACTION_HMAC_KEY_VERSION` 和独立 `REDACTION_RECOVERY_ROLE` 后，才可显式运行 `--apply`。
脚本不会创建 HMAC secret 或 recovery role 的信任策略，避免把密钥或跨账号主体猜进基础设施代码。

从本机或 S3 DR 取回备份时，先停止 `app`、`cron` 和 `generation-dispatch-worker`，复制数据库/报告，再运行同镜像的
`node /app/ops/replay-redaction-registry.cjs --restore-time <UTC RFC3339>`。runner 要求
`REDACTION_REGISTRY_BUCKET`、`REDACTION_RECOVERY_ROLE_ARN` 与 HMAC secret ARN/version；它必须在**独立 recovery
identity**（临时凭据、专用 profile 或受控 runner）中运行，应用实例角色没有也不得拥有 `sts:AssumeRole` 到 recovery role 的权限，
再读取恢复时刻仍有效的所有记录，解密、校验 HMAC，并以幂等**单一事务**写入
`provenance_redaction`；仅在成功输出计数和 key versions 后才可 `docker compose up -d`。多个 HMAC 版本时使用
`REDACTION_HMAC_SECRET_ARNS_JSON`（`{"v1":"arn:...","v2":"arn:..."}`），旧 key 须保留到最后一条记录到期。
任何 STS、S3、KMS、HMAC、缺失记录或重放错误都应非零退出并保持服务停止。恢复日志只能含 record 计数、key version 与 reason code，禁止输出 entity key。

P0a 发布包必须把上述 runner 与 `generation-dispatch-worker` 纳入 compose，并在部署 smoke test 中演练“恢复点早于删除”的
场景：停止三个服务 → 复制旧 SQLite snapshot → replay → 确认 resolver 仍返回 tombstone → 才允许启动服务。runner 不存在、
角色不可假设或任一校验失败即阻断 P0a 发布，不能回退为 6.1 的旧流程。

### 6.2 全卷冷备（含 raw，需停机）

> ⚠️ **P0a 后的恢复禁止直接解包后 `docker compose up -d`。** 旧快照可能早于删除登记；必须先回放
> §6.1.2 的 registry，且只可通过受控生产发布流程重新成为 writer。任何 replay、版本身份或 health gate 失败都保持
> `app`、`cron`、`generation-dispatch-worker` 停止。

```bash
docker compose stop app cron generation-dispatch-worker   # 静默 SQLite WAL 写入
docker run --rm -v deep-insight_insight-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/insight-data-$(date +%F).tgz -C /data .
# 恢复：解包到同名卷后，三个服务仍保持停止；先执行同镜像的 replay（替换 TS 为目标恢复点 UTC）。
docker compose run --rm --no-deps migrate \
  node /app/ops/replay-redaction-registry.cjs --restore-time 2026-08-03T00:00:00Z
# replay 成功后，不要手动 compose up；执行 §8 的受控 GHCR 发布，完成 migration / deployment-record / identity / health gate。
```

> 卷名默认 `<compose项目名>_insight-data`（项目名 `deep-insight`）。`docker volume ls` 确认。
> 第三方原文全文存在 `/data/raw`，按「不复制全文存储」原则**不入仓**，仅随卷备份。
> `npm run db:restore` 仅用于本地 worktree 的黄金快照，检测到 `NODE_ENV=production` 或
> `PROVENANCE_SCHEMA_REQUIRED=1` 会拒绝执行；它不是生产恢复入口。

## 7. 故障排查

| 症状 | 原因 / 处置 |
|---|---|
| `cron` 容器起不来 | app 未 healthy（`depends_on: service_healthy`）；查 app 健康探针；**镜像 slim 无 curl，探针/触发用 Node fetch**（compose 与 Dockerfile 已一致） |
| `cron` 容器**无健康状态**（`ps` 不显示 healthy） | 正常——cron 跑 supercronic、非 Web 服务，已在 compose **禁用**继承自镜像的 Web 探针（否则会误报 unhealthy）。判活看 `docker compose logs cron` |
| `generation-dispatch-worker` unhealthy | 内部 queue-age readiness 已判定最老 queued/过期 claimed dispatch 超过 15 分钟，或 worker 正在 drain。先看 `docker compose logs generation-dispatch-worker app`，确认没有持续的 LLM/网络失败、SQLite 锁或卡住的 in-flight Run；正常部署 drain 最多等待 2 分 15 秒，超过后由 fenced lease recovery 接管。 |
| `/api/cron` 返回 503 | `CRON_SECRET` 未配置 → 定时禁用；填 `.env.local` 重起 |
| 改 `.env.local` 后凭据/密钥不生效（如管理员密码改了登不上） | `docker compose restart` **不重读 `env_file`**——它只重启进程、env 用的是上次容器创建时的快照。必须 `docker compose up -d --force-recreate`（保留卷、重建容器即重读 env） |
| `/api/cron` 返回 401 | Bearer 与 `CRON_SECRET` 不符 |
| analyze 报错 / 拒答 | 中转站打到 sonnet（未设 `ANALYZER_MODEL=opus-*`）；敏感内容拒答由 analyzeWithSplit 隔离丢弃、不应整批失败 |
| 启动即报「校验模型必须独立于分析模型」 | `ANALYZER_MODEL == VALIDATOR_MODEL`，改成不同 Opus 版本 |
| arm64 主机 cron crash | 构建未传 `TARGETARCH=arm64` → supercronic 架构不符；重建镜像 |
| 报告生成慢 / 偶发超时 | 中转站不稳；已有 120s 超时 + 重试 + 拆批兜底；持续不稳考虑更稳接入 |
| admin 看板某些 Run `tokens > 0` 但成本显示 \$0 | 模型不在 `src/lib/runtime/cost.ts` PRICING 表内（如新发布的 Opus 版本未更新表）→ 历史 amount 静默 \$0。**清账**：`docker compose exec app node /app/ops/cost-backfill.mjs` 看 dry-run，确认后加 `--apply` 写入（用经验估算率 \$5.46/M token；可 `--rate=N` 自定义）；**根治**：补 PRICING 表 + 重 build。新代码自带 fallback 估算 + warn（commit 19880e7），不会再静默 \$0 |
| analyzer/validator/ppt-polish 全部 400 `output_config.format: Extra inputs are not permitted` | 中转站收紧请求体校验、不再接受 SDK 0.98 的新结构化输出字段 `output_config.format`。**已治本**：`callStructured` 改走通用 `tools` + `tool_choice` 把目标 schema 包装成强制工具调用（Anthropic 长稳定接口，所有中转站支持，2026-06-03 真实 relay 验证 OK）。若再次出现：升级 SDK 或检查 commit `feat(runtime)` 后 callStructured 是否仍走 tools 路径 |

## 8. 升级

本地开发可用 `docker compose up -d --build` 从当前 checkout 构建；**生产不再从源码构建**。CI（`.github/workflows/ci.yml`）通过后，`.github/workflows/publish-image.yml` 构建 `linux/amd64` 镜像并推送至 GHCR，标签固定为 `sha-<40 位提交 SHA>`。生产仅拉取这个不可变制品，因此一次发布能精确追溯到通过 CI 的提交。

> 验证别只看 `HTTP 200`（跨服务调用里 200 ≠ 成功，如飞书回 200+错误码）；用 `docker exec deep-insight-app-1 node /app/ops/probe-alert.mjs` 看渠道 + `code=0` + 真到达。

> ⚠️ **运行时配置持久化（成本熔断 / 报告推送 / 转写采集）**：`COST_LIMIT_DAILY`/`COST_LIMIT_MONTHLY`/`COST_ALERT_PCT`/`REPORT_PUSH`/`PUBLIC_BASE_URL`/`TRANSCRIPT_FETCH` 这几个常在生产手动配。
> - **`ops/aws/deploy.sh` 路径**：scp **全量覆盖**远程 `.env.local`（源 = 本地 `.env.local`，仅剔除 `DB_PATH`/`DATA_DIR`）。故生产值必须落进**本地** `.env.local`，否则下次 deploy 静默抹掉熔断/推送。已加两道护栏：`gen-env.sh` 重生成时**继承**旧 `.env.local` 的这些值；`deploy.sh` 投递前**体检缺失即告警**。
> - **`deploy.yml`（CD）路径**：只下载版本化 `docker-compose.yml` 并拉取 GHCR 镜像，绝不覆盖 `.env.local`；首次仍需由 operator 在服务器配置好该文件。
> - 仅调这几个值时：直接编辑服务器 `.env.local` 后 `docker compose up -d --force-recreate`（§7），**别重跑 `deploy.sh`/`gen-env.sh` 以免连带覆盖**；同时把值同步回本地 `.env.local` 留底。教训见 `docs/verify/mvp-gap-2026-06-07.md` §2.1。

### CI 预构建镜像 → GHCR → 生产健康切换

1. `main` 的 CI 成功后，`Publish Production Image` 在 GitHub 托管 runner 构建并发布 `linux/amd64` GHCR 镜像，附 OCI `source` / `revision` 标签、SBOM 和 provenance。镜像只使用 `sha-<commit>` 不可变标签，**不**发布 `latest`。
2. operator 在 Actions 手动运行 `Deploy Production Image`，可留空（当前 main）或指定已发布的 `sha-<commit>` 进行精确发布/回退；没有 `v*` tag 自动上线。
3. workflow 经 GitHub OIDC 取得最小 AWS SSM 角色，在生产机 `/opt/app` 下载与镜像同一 SHA 的 compose 文件、`docker pull`、核对 OCI revision。停止 writer 前会检查 `.env.local` 中生产必需的 `DISPATCH_WORKER_SECRET` 为非空（只检查存在性，绝不输出值）；随后使用不可变 digest 执行 migration / deployment-record / app 健康切换。最后连续 30 秒核验 `generation-dispatch-worker` 持续运行且重启数为 0。任一检查失败都会恢复先前 compose 和已验证镜像，并使 workflow 失败。

> ⚠️ 生产故障恢复时，不要直接执行未带变量的 `docker compose up`：Compose 会回退到 `deep-insight:0.1.0`。优先重跑 `Deploy Production Image`；确有紧急人工操作时，必须显式传入已验证的 `INSIGHT_IMAGE=ghcr.io/<owner>/<repo>@sha256:…`、`INSIGHT_IMAGE_DIGEST=sha256:…` 与 `PROVENANCE_DEPLOYMENT_REQUIRED=1`，并在启动后按本节核验运行镜像、deployment record、app health 和 worker 稳定性。

首次配置在有 AWS 管理权限的终端执行 `ops/aws/setup-github-oidc.sh`。它创建/更新仅限 `production` Environment 的 OIDC 信任和仅能对该实例执行 SSM / 查询结果的 IAM 权限；输出并可通过 `SET_GITHUB_VARIABLES=1` 写入三个 GitHub Actions repository variables：`AWS_REGION`、`AWS_DEPLOY_ROLE_ARN`、`PROD_INSTANCE_ID`。公共仓库还需由 owner 一次性使用带 `write:packages` scope 的 GitHub CLI 执行 `SET_GITHUB_PACKAGE_PUBLIC=1 ops/aws/setup-github-oidc.sh`，让生产机可匿名拉取；CI 的 `GITHUB_TOKEN` 只负责推送，不能变更 owner-level 包可见性。部署机前置条件仅是 Docker、Compose、SSM Agent 和既有 `/opt/app/.env.local` / 数据卷；不需要 checkout、Git remote、SSH 私钥或 GHCR 读取令牌。

生产 Environment 应保留 required reviewers / protection rules。部署完成后检查 workflow 的 SSM 输出（compose 状态和 `/api/health`）；如需业务级告警验证，再运行 `probe-alert.mjs`。旧的 `DEPLOY_*` SSH secrets 可在至少一次成功 GHCR 发布和部署后移除。

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
- **2026-05-31 · Run 3 屏蔽分布抽样审计（B，纯 SQL ~$0）**：
  - **swe `rep_54ed154e`**（45 洞察 / 123 引用）：blocked 13 / flagged 9 / pass 101 → **屏蔽率 10.6%**；34/45 = 76% 洞察 0 blocked；**13 条全部 `quote_not_in_source`**（reachability fail，模型 quote 漂移、`repairQuote` 兜底漏网，rule 3 引用纪律问题）。
  - **security `rep_b91964bd`**（4 洞察 / 15 引用）：blocked 3 / flagged 1 / pass 11 → 屏蔽率 20%（样本小）；**3 条全部 `exaggeration` / `out_of_context`**（consistency not_support，quote 可逐字但结论放大，rule 5 不得放大问题）。
  - **关键发现**：两批捕到**两类完全不同的失败模式、零交叉**。长内容（latent.space/Pragmatic 长文）→ quote 漂移→reachability fail；短而结构化内容（ATLAS release notes）→ 借题发挥放大→consistency fail。validator 在两条独立路径上都正常工作，A1/A2/A3 渲染（中文标签`引用不在源中` vs `夸大`/`脱离上下文`）实测可信、用户能区分根因。**两批合计：发布 110 条引用全部可达** —— "100% by construction" 在多主题、多失败模式下双重坐实。

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

## 11. 在 Google Cloud e2-micro（Always Free · 1GB）上部署（免费选项）

GCP 的 **e2-micro**（2 vCPU 共享 / **1 GB RAM** / 30GB 标准盘）是三大公有云里**唯一"永久免费"的真 VM**，定位同 §10 的 Oracle，差别只在 **RAM 仅 1 GB**（Oracle 24GB）。它是 x86，直接用 compose 默认 `TARGETARCH=amd64`，比 ARM 还省事。AWS（新号 $200 额度/6 个月、老号 12 个月）与 Azure（B1S 750h/月、仅 12 个月）也能以同样的"VM + docker compose"方式跑，但**均为限时免费、到期转按量计费**，不宜作长期落点；serverless/容器 PaaS（Lambda/Cloud Run/Functions）因**任务 14–42 分钟超时 + SQLite 本地盘有状态 + 单实例常驻**三条与本架构根本不兼容，免费额度再大也用不上。

> ⚠️ 同 §10：免费主机省"机器钱"，**省不掉模型调用钱**（每轮中转站 Opus ≈ ¥14–26，见 §4）。

**与通用步骤的关系**：§2 上线 / §6 备份 / §8 CD 全部适用；下面只列 **e2-micro/1GB 特有**注意点（核心是 1GB 内存）。

1. **开实例**：Compute Engine → e2-micro，**区域必须选 `us-central1` / `us-east1` / `us-west1` 之一**（仅这三个美国区永久免费，开在别处即按量计费）；Ubuntu LTS、30GB 标准持久盘（免费额度内）。

2. **⚠️ 1GB 内存：构建会 OOM——必先加 swap 或改预构建**。`next build` + better-sqlite3 原生编译 >1GB，1GB 机直接编译几乎必 OOM。二选一：
   - **加 2GB swap**（最省事，顺带兜运行时峰值）：
     ```bash
     sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
     sudo mkswap /swapfile && sudo swapon /swapfile
     echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 重启自动挂
     ```
   - 或**改 CD 为预构建镜像**：CI 里 build → push 到 registry → 服务器只 `docker compose pull`（运行时 1GB 够，不在小机上编译）。当前 `deploy.yml` 是服务器侧 `up --build`，走这条路必须先配 swap。

3. **运行时内存可控（设计本就轻）**：管线 14–42 分钟几乎全在等中转站 LLM 的 HTTP 往返，非内存密集——源**串行采集**（`ingestConcurrency: 1`）、单次抓取封顶 8MB 且流式不整体入内存（`safe-fetch.ts`）、每条正文截断 50KB（`normalize.ts`）、单批最多 25 条 ≈ 1.25MB 文本、LLM 走流式且输出有界。实测预算 ~0.5–0.8GB，**塞进 1GB 但余量不大**。建议给 app 服务设堆上限兜底，避免 V8 默认堆顶满触发 OOM-killer：
   ```yaml
   # docker-compose.yml 的 app 服务下追加
   environment:
     NODE_OPTIONS: "--max-old-space-size=512"
   ```
   配合 §11.2 的 swap，运行时偶发峰值有去处。

4. **持久化 / 反代 / CD**：同 §10 第 4–6 点——Docker 命名卷落持久启动盘自动持久；防火墙（GCP **VPC Firewall**）放行入站 80/443、3000 不对公网开；自备域名 A 记录指向公网 IP 上 Caddy；`deploy.yml` 的 `DEPLOY_HOST` = 公网 IP，x86 机 `TARGETARCH` 自动解析为 `amd64`。

> 一句话：e2-micro **够用、余量小**——构建用 swap/预构建绕开、运行时设 `--max-old-space-size` 兜底即可长期免费跑。要零调优 + 大余量，§10 的 Oracle Ampere（24GB）更舒服。

## 12. 失败告警接线（DCP-3 ② ✅ 已闭合：多渠道 adapter）

`notifyFailure` 钩子（`src/lib/runtime/alert.ts`）在 Run 失败时 fire-and-forget 发告警，**按 `ALERT_WEBHOOK` URL 自动识别渠道**并翻译 payload（`ALERT_CHANNEL` 可显式覆盖）。失败先归一到中性 `Notification`（标题 + 正文 + 高优 + 🔴 tag），再按渠道翻译——这一层「报告推送」已复用（见本节末「报告推送」）。

### 渠道对照（已实现 ✅ / 推后 ⏳）

| 渠道 | 状态 | 识别规则（host/path）| payload | 国内 | 平台覆盖 |
|---|---|---|---|---|---|
| **飞书 群机器人**（默认主推）| ✅ | `feishu.cn`/`larksuite.com` + `/bot/v2/hook/` | `{msg_type:"text", content:{text}}`，可选加签 | ✅ 直通 | 安卓/iOS/**鸿蒙 NEXT** |
| **ntfy** | ✅ | host=`ntfy.sh` 或其子域（自建用 `ALERT_CHANNEL=ntfy`）| JSON publish 到 origin、topic 取 path 第一段、`click`=链接 | ⚠️ 公共实例不稳，自托管后优 | 安卓✅/iOS可/鸿蒙❌ |
| **Slack** | ✅ | host=`slack.com` 或其子域 | `{text}` | ❌ 需 VPN | 全 |
| **Discord** | ✅ | host=`discord.com`/`discordapp.com` 或其子域 | `{content}` | ❌ 需 VPN | 全 |
| **generic**（含 webhook.site）| ✅ | 兜底 | `{text, title, priority, tags, link}` | ✅ | 仅浏览器（占位）|
| Bark（iOS）| ⏳ 推后 | — | device-key 在 URL、非标准 webhook | ⚠️ | 仅 iOS |
| PushDeer | ⏳ 推后 | — | pushkey 不在 URL、schema 不一致 | ✅ | 安卓/iOS |

> 渠道优劣详析见 `docs/verify/mvp-gap-2026-06-07.md` 的推送分析。**默认主推飞书**：国内单用户唯一同时满足"零 VPN 直通 + 鸿蒙覆盖 + 利于报告推送富卡片"。

### 接线步骤

**飞书（推荐）**：飞书建群 → 群设置 → 群机器人 → 添加「自定义机器人」→ 拷 webhook URL → 填 `ALERT_WEBHOOK`。若开了「签名校验」，把密钥填 `ALERT_FEISHU_SECRET`。

**ntfy**：装 ntfy App（安卓）→ 订阅一个 topic（如 `insight-alert-<随机后缀>`）→ `ALERT_WEBHOOK=https://ntfy.sh/insight-alert-<随机后缀>`。自建服务器则同时设 `ALERT_CHANNEL=ntfy`。

**占位调试**：浏览器开 https://webhook.site → 拷 inbox URL → 填 `ALERT_WEBHOOK`（识别为 generic，浏览器可见 payload，不推手机）。

### 烟雾验证（不等真 Run 挂）

`ops/probe-alert.mjs` 会打印识别到的渠道 + 实际 body，并真发一条：

```bash
# 本地（任意渠道——脚本按 URL 自动识别）
ALERT_WEBHOOK=<url> node ops/probe-alert.mjs

# 容器内（注意 -T 让 exec 透传 env）
docker compose exec -T -e ALERT_WEBHOOK=<url> app node /app/ops/probe-alert.mjs
```

期望：飞书/ntfy → **手机 App 收到**；generic → webhook.site inbox 可见。

### 报告推送（生成完报告主动推给用户）

`notifyReport` 钩子（`src/lib/runtime/alert.ts`，接在 `runReportGen` 落库之后）复用上面同一渠道层，把新生成的报告推给用户，**点进 = 报告 deep-link**（移动端可读）。与失败告警**共用 `ALERT_WEBHOOK`**，但有独立开关：

| env | 作用 | 缺省 |
|---|---|---|
| `REPORT_PUSH=1` | 开启报告推送（独立 opt-in——失败告警是运维信号、报告推送是日常内容流，混同渠道默认全开会刷屏）| 关 |
| `PUBLIC_BASE_URL` | 用户可达的站点根地址，拼 deep-link（`<base>/reports/<id>`）；缺失则推送照发、仅不带链接。**与容器内网 `APP_URL`（http://app:3000）区分** | 无 |

**推送规则**：`brief` 默认优先级 + 📰 newspaper tag；**空 brief（"本期无重要事件"）自动跳过**，避免每天推噪音；`deep_dive` / `initial_digest` 是用户触发 / 冷启动首报，即便条目少也始终推。非阻塞、永不抛——推送失败绝不连累已落库的报告（report-gen Run 已 done）。

**多渠道扇出**：报告推送会**同时发到所有已配渠道**——飞书 webhook（`ALERT_WEBHOOK`）+ 邮件（SMTP）。各渠道独立、缺配即跳过；**运维告警（失败/预算）不发邮件、仍只走飞书**。邮件渠道（`src/lib/runtime/email.ts`，nodemailer SMTP）：

| env | 作用 | 缺省 |
|---|---|---|
| `SMTP_HOST` | SMTP 服务器（QQ `smtp.qq.com` / 163 `smtp.163.com` / Gmail `smtp.gmail.com` / 企业邮）；**与 `REPORT_EMAIL_TO` 都配齐才发邮件** | 无（不发邮件）|
| `SMTP_PORT` | 465=隐式 TLS / 587=STARTTLS | 465 |
| `SMTP_USER` / `SMTP_PASS` | 账号 + **客户端授权码**（非登录密码，邮箱设置里生成）| 无 |
| `SMTP_FROM` | 发件人，缺省回退 `SMTP_USER` | =SMTP_USER |
| `REPORT_EMAIL_TO` | 收件人【兜底】：现以**设置页→邮件分发收件人**（入库）为准，库里有启用收件人即以库为准；本 env 仅在库为空时回落。逗号分隔多个 | 无（库也空时不发邮件）|

> 邮件用 SMTP 不用邮件服务 API：零注册、零域名验证、用现有邮箱即可，适合低频少收件人的 brief 推送。`REPORT_PUSH`/`SMTP_*`/`REPORT_EMAIL_TO` 同属「生产手动配的运行时配置」，记得持久化进本地 `.env.local`。

**收件人管理（设置页）**：收件名单已从「改服务器 env」迁到 **设置页 → 邮件分发收件人**（admin only，存 `email_recipient` 表）：增删、停用（暂停但保留）、备注。`notifyEmail` 取**启用收件人**拼逗号串发送；**库里有启用收件人即以库为准、`REPORT_EMAIL_TO` 被忽略**；全删/全停或库不可用才回落 `REPORT_EMAIL_TO`（兜底，零回归）。SMTP 发信账号（`SMTP_HOST/USER/PASS/FROM`）仍由 env 配置——只有「发给谁」搬进了网页。

接线：在已配 `ALERT_WEBHOOK` 基础上加 `REPORT_PUSH=1` + `PUBLIC_BASE_URL=https://<域名或 EC2-IP:3000>`（飞书），可选再加上面 SMTP 一组（邮件）+ 在设置页加收件人。验证：手动触发一次深挖（`/api/topics/[id]/deep-dive`）→ 飞书收到卡片、邮箱收到带链接的邮件。

## 13. 定时真模型 eval（A1 回归门 · DCP-3 ②）

真模型 eval 不进公共 CI（需凭据 + 预算 + 中转站）。由定时 workflow `.github/workflows/eval.yml` 跑：**每周一次** + 可手动触发（`workflow_dispatch`，可限量做廉价冒烟）。`run-a1.ts` 自带阈值门 + `baseline.json` 回归对照（任一指标较基线降 >3pp → 非零退出 → job 变红），失败时复用渠道 adapter 推告警到 `ALERT_WEBHOOK`。

**关键：用中转站 relay 凭据即可，不需要直连 `sk-ant-` key**（`run-a1.ts` 只要求 `ANTHROPIC_API_KEY` 存在，`sk-ant-` 仅软警告）。

### 在 repo 配置（Settings → Secrets and variables → Actions）

| 类型 | 名称 | 必填 | 说明 |
|---|---|---|---|
| Secret | `ANTHROPIC_API_KEY` | ✅ | relay 凭据 |
| Secret | `ANTHROPIC_BASE_URL` | ✅ | relay 端点 |
| Variable | `ANALYZER_MODEL` | ✅ | Opus-only relay 必设为 Opus（如 `claude-opus-4-6`），且须与 validator 不同（否则 `assertModelSeparation` 报错） |
| Variable | `VALIDATOR_MODEL` | 建议 | 默认 `claude-opus-4-7` |
| Secret | `ALERT_WEBHOOK` | 可选 | 配了则 eval 失败推告警（§12 同款渠道识别）；不配则只看 GitHub 失败通知 |
| Secret | `ALERT_FEISHU_SECRET` | 可选 | 飞书加签模式 |
| Variable | `ALERT_CHANNEL` | 可选 | 覆盖渠道自动识别 |

### ⚠️ 网络前提与退路

GitHub 托管 runner 在境外，**必须能访问你的 relay**。若 relay 限国内 IP/区域 → runner 连不上、eval 网络失败。两条退路：
1. **self-hosted runner**：把 runner 跑在能访问 relay 的机器/VPS 上（`runs-on` 改为你的 self-hosted label）；
2. **容器内跑**：加 `/api/eval` 端点 + 把 eval 数据集打进镜像，在 app 容器进程内跑（relay 已在容器内可达，同管线路径）。

> 成本：标准 arXiv 集 = 5 主题 + 120 一致性对 ≈ 125 个 Opus relay 调用/次，周频可接受；手动触发时可用 `quality_limit`/`consistency_limit` 限量省钱。

## 14. 成本预算控制（A5 · DCP-3 ①）

度量地基（每段 `Run.cost` 落库 + admin 成本时序图）之上加配额校验 + 触顶熔断 + 看板用量。判定核心
`src/lib/runtime/cost-guard.ts`，配置走三个 env（见 §3）：`COST_LIMIT_DAILY` / `COST_LIMIT_MONTHLY`（USD）
/ `COST_ALERT_PCT`（默认 80）。**未配任何上限 = 不限 = 行为与改动前完全一致（零回归）。**

### 行为

- **判定窗口**：日 = 当日 00:00 UTC 起；月 = 当月 1 号 00:00 UTC 起（自然月，对齐账单）。已花额取自
  `run.cost.amount`（含分析/校验等所有调 LLM 的段；确定性段如采集/报告生成不计）。
- **自动管线（cron / `runScheduledPipeline`）**：每个 topic 前查预算——
  - `exceeded`（任一维度 ≥ 上限）→ **硬熔断**：跳过本 topic 及之后全部，`summary` 标
    `skipped-budget-exceeded` + `budgetStopped=true`，发一次「触顶」告警；下一轮 cron（次日预算重置）自动恢复。
  - `alert`（任一维度 ≥ `COST_ALERT_PCT`%）→ 发一次「接近上限」告警，**继续跑**。
  - 告警每 cron 进程去重（≤1 条/轮 → ≤4 条/天）。
- **手动操作（深挖 / 追问）**：预算触顶**不拦**（用户主动意图，保留应急能力）——仅记日志 + 发一次
  `manual` 告警（措辞「已放行，未自动暂停」）。
- **看板**：`/admin` 顶部「成本预算」卡片显示今日 / 本月 spent vs 上限 + 进度条 + 状态徽标（正常 / ⚠️接近 / ⛔触顶）；
  未配上限时显提示文案。

### 接线

配 `COST_LIMIT_DAILY` 和/或 `COST_LIMIT_MONTHLY`（USD）即生效；告警复用 `ALERT_WEBHOOK`（无独立 opt-in——
预算是运维信号，配了 webhook 就该收到）。Opus-on-relay 含校验单轮 ≈ ¥14-26，按月用量与汇率折算 USD 填限额。
改 env 后须 `docker compose up -d --force-recreate`（见 §7 重读 env 说明）。
