#!/usr/bin/env bash
# 在 AWS 上拉起 EC2：密钥对 + 安全组 + t3.micro(Ubuntu 24.04, 挂 user-data) + 30GB gp3 + 公网 IP。
# 前置：① aws CLI 已装  ② aws configure 已配好凭据(或 aws sso login)。
# 用法：cp config.sh.example config.sh && 改好  →  ./provision.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f config.sh ] || { echo "缺 config.sh：先 cp config.sh.example config.sh 并按需修改"; exit 1; }
source config.sh

command -v aws >/dev/null || { echo "未装 aws CLI。Mac：brew install awscli，然后 aws configure"; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "未配置凭据。先跑：aws configure（填 Access Key/Secret/区域）"; exit 1; }

R="$AWS_REGION"; NAME="$AWS_NAME"
echo "==> 账号：$(aws sts get-caller-identity --query Account --output text)  区域：$R"
echo "==> 实例：$NAME ($AWS_INSTANCE_TYPE, ${AWS_DISK_GB}GB gp3)"

# 1) 解析 Ubuntu 24.04 AMI（Canonical 官方 SSM 公共参数，跨区自适应）
echo "==> 解析 Ubuntu 24.04 AMI..."
AMI=$(aws ssm get-parameters --region "$R" \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { echo "✗ AMI 解析失败（区域 $R 是否需 opt-in？）"; exit 1; }
echo "    AMI=$AMI"

# 2) 默认 VPC
VPC=$(aws ec2 describe-vpcs --region "$R" --filters Name=isDefault,Values=true \
        --query 'Vpcs[0].VpcId' --output text)
[ -n "$VPC" ] && [ "$VPC" != "None" ] || { echo "✗ 无默认 VPC。新账号一般自带；可在 VPC 控制台 'Create default VPC'"; exit 1; }
echo "==> 默认 VPC：$VPC"

# 3) 密钥对（无则创建并保存 pem）
if aws ec2 describe-key-pairs --region "$R" --key-names "$NAME" >/dev/null 2>&1; then
  echo "==> 密钥对 $NAME 已存在（复用 ${SSH_KEY}）"
else
  echo "==> 创建密钥对 $NAME -> $SSH_KEY"
  aws ec2 create-key-pair --region "$R" --key-name "$NAME" \
    --query KeyMaterial --output text > "$SSH_KEY"
  chmod 400 "$SSH_KEY"
fi

# 4) 安全组（22 限来源 / 80 / 443）
SG=$(aws ec2 describe-security-groups --region "$R" \
      --filters Name=group-name,Values="$NAME-sg" Name=vpc-id,Values="$VPC" \
      --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  echo "==> 创建安全组 $NAME-sg"
  SG=$(aws ec2 create-security-group --region "$R" --group-name "$NAME-sg" \
        --description "deep-insight web+ssh" --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$R" --group-id "$SG" \
    --protocol tcp --port 22  --cidr "${SSH_ALLOW_CIDR:-0.0.0.0/0}" --output text >/dev/null
  aws ec2 authorize-security-group-ingress --region "$R" --group-id "$SG" \
    --protocol tcp --port 80  --cidr 0.0.0.0/0 --output text >/dev/null
  aws ec2 authorize-security-group-ingress --region "$R" --group-id "$SG" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 --output text >/dev/null
else
  echo "==> 安全组已存在：$SG"
fi
echo "    SG=${SG}（SSH 来源：${SSH_ALLOW_CIDR:-0.0.0.0/0}）"

# 5) 启动实例（user-data=cloud-init；自动分配公网 IP；30GB gp3 随实例删除）
echo "==> 启动 EC2（含 user-data，约 30–60 秒到 running）..."
IID=$(aws ec2 run-instances --region "$R" \
  --image-id "$AMI" --instance-type "$AWS_INSTANCE_TYPE" \
  --key-name "$NAME" --security-group-ids "$SG" \
  --associate-public-ip-address \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${AWS_DISK_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --user-data file://cloud-init.yaml \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "$IID" > .vm-id
echo "    InstanceId=$IID"

aws ec2 wait instance-running --region "$R" --instance-ids "$IID"
IP=$(aws ec2 describe-instances --region "$R" --instance-ids "$IID" \
      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$IP" > .vm-ip

echo ""
echo "==================================================================="
echo " EC2 已运行。公网 IP：$IP   （已写入 ops/aws/.vm-ip）"
echo " user-data 正在后台装 Docker/swap/Caddy（约 2–4 分钟）。"
echo ""
echo " 下一步："
echo "   1) ./gen-env.sh          # 生成 .env / .env.local（含 openssl 密钥）"
echo "   2) ./migrate-db.sh       # 可选：迁移现有生产数据到云端卷"
echo "   3) ./deploy.sh           # 投递代码 + docker compose up + 配 Caddy"
echo ""
echo " 止费：./destroy.sh  （终止实例 + 删安全组/密钥）"
echo "==================================================================="
