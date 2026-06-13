#!/usr/bin/env bash
# off-box DR 一次性搭建（幂等，可重跑）—— 在 ops/backup-db.mjs 同卷备份之上多一层异地副本。
#
# 做三件事：
#   1) 建私有 S3 桶 deep-insight-backups-<账号ID>（同区 ap-southeast-1→上传免流量费）：
#      阻断公开访问 + 版本控制 + SSE-S3 默认加密 + 生命周期（对象 90 天 / 旧版本 30 天，限成本）。
#   2) 给 EC2 实例角色 <AWS_NAME>-ssm 挂最小内联策略 s3-dr-backups（仅本桶 List/Put/Get）。
#   3) 经 SSM（免 SSH、穿 GFW）在实例上：装 awscli v2（缺则装）+ 写 host cron
#      /etc/cron.d/deep-insight-dr，每日 18:30 UTC `aws s3 sync /data/backups → s3://桶/ec2/`。
#
# 成本：备份 ~6MB/天、留 90 天 ≈ 0.5GB → 存储 ~$0.01/月；同区上传免流量费；走 AWS 额度 ≈ $0。
#
# 前置：aws configure 已配（同 provision.sh 的凭据）；实例已 provision 且 SSM 在线。
# 用法：cd ops/aws && ./setup-dr.sh
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
export AWS_DEFAULT_REGION="$AWS_REGION"

ACCT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${DR_BUCKET:-${AWS_NAME}-backups-${ACCT}}"
ROLE="${AWS_NAME}-ssm"   # provision.sh 以 AWS_NAME 为前缀建的实例角色
IID="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${AWS_NAME}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
# 必须恰好 1 个：多个（蓝绿 / 未清的旧实例）会被 --output text 用 tab 拼成一串，
# 当成单个 --instance-ids 传给 SSM 会失败或误打到歧义目标。
if [ "$(printf '%s' "$IID" | wc -w | tr -d ' ')" != "1" ] || [ "$IID" = "None" ]; then
  echo "✗ 期望恰好 1 个运行中实例（tag:Name=${AWS_NAME}），实得：'${IID:-空}'"; exit 1
fi
echo "账号=$ACCT  桶=$BUCKET  角色=$ROLE  实例=$IID  区域=$AWS_REGION"

# 1) S3 桶（幂等）
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "==> 桶已存在，跳过创建"
else
  echo "==> 建桶 $BUCKET"
  # us-east-1 是 S3 的默认区，传 LocationConstraint=us-east-1 反而报 IllegalLocationConstraint；
  # 其余区必须带 LocationConstraint。
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-dr-backups","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":90},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'
echo "==> 桶加固完成（阻断公开 / 版本控制 / AES256 / 生命周期 90·30）"

# 2) 实例角色最小内联策略（幂等：put 覆盖同名策略）
POL="$(mktemp)"; trap 'rm -f "$POL"' EXIT
cat > "$POL" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListDRBucket", "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}" },
    { "Sid": "RWDRObjects", "Effect": "Allow", "Action": ["s3:PutObject","s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$ROLE" --policy-name s3-dr-backups --policy-document "file://$POL"
echo "==> 已挂 IAM 内联策略 s3-dr-backups → $ROLE"

# 3) 实例侧：装 awscli + host cron（经 SSM）
VOL='/var/lib/docker/volumes/deep-insight_insight-data/_data'
# cron 文件内容 base64（避免 SSM/JSON/shell 多层引号）
CRON_B64="$(printf '%s\n' \
"# Deep Insight off-box DR: 每日 18:30 UTC 把卷内备份 /data/backups 同步到 S3（容器内 18:00 备份之后）" \
"30 18 * * * root AWS_DEFAULT_REGION=${AWS_REGION} /usr/local/bin/aws s3 sync ${VOL}/backups s3://${BUCKET}/ec2/ --no-progress >> /var/log/deep-insight-dr.log 2>&1" \
| base64 | tr -d '\n')"

PARAMS="$(mktemp)"; trap 'rm -f "$POL" "$PARAMS"' EXIT
cat > "$PARAMS" <<JSON
{ "commands": [
  "if ! command -v aws >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq unzip && curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip && cd /tmp && unzip -oq awscliv2.zip && sudo ./aws/install && cd /; fi",
  "/usr/local/bin/aws --version",
  "echo '${CRON_B64}' | base64 -d | sudo tee /etc/cron.d/deep-insight-dr",
  "sudo chmod 644 /etc/cron.d/deep-insight-dr && sudo chown root:root /etc/cron.d/deep-insight-dr",
  "sudo AWS_DEFAULT_REGION=${AWS_REGION} /usr/local/bin/aws s3 sync ${VOL}/backups s3://${BUCKET}/ec2/ --no-progress",
  "AWS_DEFAULT_REGION=${AWS_REGION} /usr/local/bin/aws s3 ls s3://${BUCKET}/ec2/ --recursive --summarize | tail -3"
] }
JSON
echo "==> SSM 在实例上装 awscli + 写 cron + 首次同步..."
CID="$(aws ssm send-command --instance-ids "$IID" \
  --document-name AWS-RunShellScript --comment "setup off-box DR" \
  --timeout-seconds 120 --parameters "file://$PARAMS" \
  --query 'Command.CommandId' --output text)"
# 轮询上限 30×15s=450s：冷装 awscli v2（apt + 下载 60MB + 首次 s3 sync）可能慢，
# 预算给足，且把"超时仍 InProgress / 状态读不到"与"真失败 Failed"分开处理。
ST=""
for _ in $(seq 1 30); do
  ST="$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || true)"
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 15
done
echo "SSM 状态=${ST:-未知}"
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query 'StandardOutputContent' --output text 2>/dev/null || true
case "$ST" in
  Success) ;;
  InProgress|Pending|"")
    echo "⚠ SSM 命令 450s 内未结束（仍在跑或状态读取失败）。桶 + IAM 已就绪；实例侧 awscli/cron 可能还在装。"
    echo "  稍后核对：aws ssm get-command-invocation --command-id $CID --instance-id $IID --query Status --output text --region $AWS_REGION"
    exit 2 ;;
  *) echo "✗ SSM 步骤失败（状态=$ST），查上面输出"; exit 1 ;;
esac

echo ""
echo "==================================================================="
echo " off-box DR 就绪：桶 s3://$BUCKET/ec2/  · cron /etc/cron.d/deep-insight-dr（每日 18:30 UTC）"
echo " 详见 operations.md §6.1.1。手动同步 / 取回见该节命令。"
echo "==================================================================="
