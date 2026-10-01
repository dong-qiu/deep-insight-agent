# 云部署工具包（AWS EC2）

AWS EC2 历史主机准备工具包（t3.micro / Ubuntu 24.04 / Docker + 持久卷 + 容器内 cron）。
**当前 CD 仅支持已初始化、存在运行中 app/既有备份的生产实例**；下列主机准备步骤不是可直接执行的全新主机首发流程。
全新主机的安全首次发布尚需单独设计和验证，不得把旧 `deploy.sh` 重新启用作为捷径。

> 选 AWS 而非 Azure 的原因：Azure 新订阅 B1s 容量被封 + 公网 IP 收费；AWS t3.micro 一般随时可建、IPv4 含 750h/月免费。

## 你必须亲手做的 3 件事

1. **注册 AWS 账号 + 绑卡 + 实名**（浏览器，一次性）
2. **`aws configure`**——填 Access Key / Secret / 默认区域（一次性；之后 provision 全自动）
3. **DNS A 记录**——要 HTTPS 才需，把域名指向 EC2 公网 IP（在你的域名商后台）

> 生产发布的唯一入口是 GitHub Actions `Deploy Production Image`：它只拉取 CI 已推送的 GHCR 不可变镜像，
> 不在生产机拉源码或构建。旧 `deploy.sh` 已停用，调用只会失败，不会传输本地配置。

## 历史主机准备步骤（首发流程未闭合）

```bash
# 0) 前置：装 aws CLI 并配置凭据
brew install awscli
aws configure        # AKID / Secret / region(ap-southeast-1) / output(json)

# 1) 配置（非密钥）
cd ops/aws
cp config.sh.example config.sh
$EDITOR config.sh    # 区域/实例型号/域名/SSH 来源 CIDR

# 2) 拉起 EC2（密钥对 + 安全组 + t3.micro + 30GB gp3 + 公网IP + user-data 自装 Docker/swap/Caddy）
./provision.sh       # 完成后公网 IP 写入 .vm-ip

# 3) 生成 .env / .env.local（openssl 现场生成密钥，写进 gitignored 文件）
# 默认 Anthropic（兼容旧 ANTHROPIC_API_KEY）：
LLM_API_KEY=sk-xxx ADMIN_PASSWORD=xxx ./gen-env.sh
# Volcengine Coding Plan：先在 config.sh 设置 LLM_PROVIDER=volcengine-responses、
# LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3，再执行：
LLM_API_KEY=<Coding-Plan-key> ADMIN_PASSWORD=xxx ./gen-env.sh

# 4) 仅在另行批准的数据迁移任务中，核实目标卷确为空后再评估 migrate-db.sh；
#    正常首次发布不需要迁移历史数据，也不运行此旧脚本。

# 5) 停在此处：全新主机还需要单独批准的安全首发流程。
#    当前 GitHub Actions「Deploy Production Image」要求已有 app、compose 和备份，
#    只能用于已初始化实例的后续发布；旧 deploy.sh 不得恢复使用。
#    已有生产实例的发布与核验见 docs/launch/operations.md §8。

```

`setup-dr.sh`、`setup-a1-eval-snapshot.sh` 与 `destroy.sh` 分别涉及异地备份、评测资源和下线销毁，
不是首次发布的连续步骤；仅在各自独立任务得到授权并核对目标后执行。

## 各脚本职责

| 文件 | 作用 | 需要凭据? |
|---|---|---|
| `config.sh.example` | 非密钥部署参数模板（cp 成 `config.sh`，已 gitignore） | — |
| `cloud-init.yaml` | EC2 user-data：首次开机自装 Docker/swap/Caddy（**不含密钥、不 clone**） | — |
| `provision.sh` | `aws ec2` 建密钥对 + 安全组 + 实例 + 公网 IP | 需 `aws configure` |
| `gen-env.sh` | 生成 `.env` / `.env.local`（密钥用 openssl） | API key / 管理员密码 |
| `migrate-db.sh` | 历史数据迁移工具；未强制校验空卷，**不得直接用于已有生产卷**，另行批准和加固 | SSH 私钥 |
| `deploy.sh` | 已停用的旧入口：立即拒绝；不传代码或密钥，不覆盖生产配置 | 否 |
| `setup-dr.sh` | off-box DR：建 S3 桶（加固）+ 实例角色挂最小 S3 策略 + 经 SSM 装 awscli/写 host cron 每日异地同步 | 需 `aws`（建桶/IAM/SSM） |
| `setup-redaction-registry.sh` | P0a 独立 Object-Lock redaction registry + KMS + app/recovery 最小策略；默认只读检查，`--apply` 才变更 | 需 `aws`、预建 HMAC secret 与独立 recovery role |
| `setup-a1-eval-snapshot.sh` | A1 v2 原文快照专用 bucket：私有、versioning、专用 KMS、Object Lock Compliance 90 天、到期 lifecycle；不接入生产 app role | 需 `aws`；仅由经授权 evaluator 上传 |
| `destroy.sh` | 终止实例 + 删安全组/密钥，止费 | 需 `aws` |

## 设计要点 / 安全

- **user-data 不放密钥**：实例元数据可读，故只做基础设施；运行时配置由 operator 一次性置于服务器，发布只走 CD。
- **不 clone 私库**：发布从 GHCR 拉取不可变镜像，生产机无需仓库 checkout 或 PAT。
- **`.env.local` 永不入库**：`.gitignore` 已忽略 `.env.*`；`config.sh`、`.vm-ip`、`.vm-id` 也已忽略。
- **工程名钉死** `COMPOSE_PROJECT_NAME=deep-insight` → 卷恒为 `deep-insight_insight-data`，换目录/重跑不孤立数据。
- **模型校验**：`gen-env.sh` 要求 analyzer、validator、coverage 三个模型两两不同；缺失或重复会在写入运行时配置前失败。
- **SSH 收窄**：安全组 22 端口只放行 `SSH_ALLOW_CIDR`（默认你的公网 IP）。

## 费用提示（AWS）

- 新账号走**额度制**（$100–200 / 6 个月），单台 t3.micro + 30GB + IPv4 ≈ ~$13/月，**额度内卡上 $0**；Free Plan 额度耗尽自动暂停，不扣卡。
- **公网 IPv4 含 750h/月免费**（够 1 台 24×7）——这是 AWS 比 Azure 省心处。
- 仍是限时（额度 6 个月 / 经典档 12 个月）；长期真 $0 需迁 Oracle Always Free（脚本可复用，只换 provision）。

## 常用运维（部署后）

```bash
IP=$(cat ops/aws/.vm-ip); KEY=~/.ssh/deep-insight.pem
ssh -i $KEY ubuntu@$IP 'cd /opt/app && docker compose logs --since 24h app | grep -i brief'   # 今天采集了吗
# 日常更新：在 main 分支运行 GitHub Actions「Deploy Production Image」（选择 sha-<commit> 标签）
./destroy.sh                                                                                   # 下线止费
```

> 上云后**生产库 = 这台 EC2 上的卷 `deep-insight_insight-data`**，排查采集要 SSH 上来查，不再是本机 `.data`。
