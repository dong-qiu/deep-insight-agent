# 云部署工具包（AWS EC2）

把 Insight Agent 部署到 AWS EC2（t3.micro / Ubuntu 24.04 / Docker + 持久卷 + 容器内 cron）。
脚本把"手工控制台操作"压缩成几条命令；只剩 3 个环节离不开你。

> 选 AWS 而非 Azure 的原因：Azure 新订阅 B1s 容量被封 + 公网 IP 收费；AWS t3.micro 一般随时可建、IPv4 含 750h/月免费。

## 你必须亲手做的 3 件事

1. **注册 AWS 账号 + 绑卡 + 实名**（浏览器，一次性）
2. **`aws configure`**——填 Access Key / Secret / 默认区域（一次性；之后 provision 全自动）
3. **DNS A 记录**——要 HTTPS 才需，把域名指向 EC2 公网 IP（在你的域名商后台）

> 代码用 rsync 投递本地仓库，**不需要 GitHub PAT**。

## 运行顺序

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
ANTHROPIC_API_KEY=sk-xxx ADMIN_PASSWORD=xxx ./gen-env.sh

# 4) 可选：迁移本机现有生产数据到云端卷（保留采集历史；务必在 deploy 之前）
./migrate-db.sh

# 5) 投递代码 + 起服务 + 配 Caddy + 验证
./deploy.sh

# 止费（释放所有 EC2 资源，账单归零）
./destroy.sh
```

## 各脚本职责

| 文件 | 作用 | 需要凭据? |
|---|---|---|
| `config.sh.example` | 非密钥部署参数模板（cp 成 `config.sh`，已 gitignore） | — |
| `cloud-init.yaml` | EC2 user-data：首次开机自装 Docker/swap/Caddy（**不含密钥、不 clone**） | — |
| `provision.sh` | `aws ec2` 建密钥对 + 安全组 + 实例 + 公网 IP | 需 `aws configure` |
| `gen-env.sh` | 生成 `.env` / `.env.local`（密钥用 openssl） | API key / 管理员密码 |
| `migrate-db.sh` | 本机生产容器 `VACUUM INTO` 快照 → 写入云端卷 | SSH 私钥 |
| `deploy.sh` | rsync 代码 + `docker compose up` + Caddy + 健康检查 | SSH 私钥 |
| `destroy.sh` | 终止实例 + 删安全组/密钥，止费 | 需 `aws` |

## 设计要点 / 安全

- **user-data 不放密钥**：实例元数据可读，故只做基础设施；代码/密钥经 `deploy.sh` 走加密 rsync/ssh。
- **不 clone 私库**：`deploy.sh` 直接 rsync 本机这份仓库，免 PAT。
- **`.env.local` 永不入库**：`.gitignore` 已忽略 `.env.*`；`config.sh`、`.vm-ip`、`.vm-id` 也已忽略。
- **工程名钉死** `COMPOSE_PROJECT_NAME=deep-insight` → 卷恒为 `deep-insight_insight-data`，换目录/重跑不孤立数据。
- **模型校验**：`gen-env.sh` 拦截 `ANALYZER_MODEL == VALIDATOR_MODEL`（应用此约束下会启动失败）。
- **SSH 收窄**：安全组 22 端口只放行 `SSH_ALLOW_CIDR`（默认你的公网 IP）。

## 费用提示（AWS）

- 新账号走**额度制**（$100–200 / 6 个月），单台 t3.micro + 30GB + IPv4 ≈ ~$13/月，**额度内卡上 $0**；Free Plan 额度耗尽自动暂停，不扣卡。
- **公网 IPv4 含 750h/月免费**（够 1 台 24×7）——这是 AWS 比 Azure 省心处。
- 仍是限时（额度 6 个月 / 经典档 12 个月）；长期真 $0 需迁 Oracle Always Free（脚本可复用，只换 provision）。

## 常用运维（部署后）

```bash
IP=$(cat ops/aws/.vm-ip); KEY=~/.ssh/deep-insight.pem
ssh -i $KEY ubuntu@$IP 'cd /opt/app && docker compose logs --since 24h app | grep -i brief'   # 今天采集了吗
ssh -i $KEY ubuntu@$IP 'cd /opt/app && docker compose up -d --build'                          # 更新后重部署
./destroy.sh                                                                                   # 下线止费
```

> 上云后**生产库 = 这台 EC2 上的卷 `deep-insight_insight-data`**，排查采集要 SSH 上来查，不再是本机 `.data`。
