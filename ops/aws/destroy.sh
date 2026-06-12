#!/usr/bin/env bash
# 止费：终止 EC2 实例 + 释放 Elastic IP + 删安全组 + 删密钥对。账单归零。
# ⚠️ EIP 必须显式释放——实例终止后 EIP 会变"闲置"，闲置 EIP 不在免费额度内、按 ~$3.6/月计费。
# 用法：./destroy.sh         # 交互确认
#       ./destroy.sh --yes   # 跳过确认
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
R="$AWS_REGION"; NAME="$AWS_NAME"

[ "${1:-}" = "--yes" ] || { read -rp "确认终止实例 $NAME 及其安全组/密钥? 输 yes 继续: " a; [ "$a" = yes ] || exit 1; }

if [ -f .vm-id ]; then
  IID="$(cat .vm-id)"
  echo "==> 终止实例 $IID ..."
  aws ec2 terminate-instances --region "$R" --instance-ids "$IID" --output text >/dev/null || true
  aws ec2 wait instance-terminated --region "$R" --instance-ids "$IID" || true
  rm -f .vm-id .vm-ip
fi

# 释放 Elastic IP（按 Name=$NAME 标签找；实例终止后已自动解绑，直接 release）。
# 不释放 = 闲置 EIP 持续计费，这是 destroy 最容易漏的一步。
ALLOC=$(aws ec2 describe-addresses --region "$R" \
  --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
if [ -n "$ALLOC" ] && [ "$ALLOC" != "None" ]; then
  echo "==> 释放 Elastic IP $ALLOC ..."
  ASSOC=$(aws ec2 describe-addresses --region "$R" --allocation-ids "$ALLOC" \
    --query 'Addresses[0].AssociationId' --output text 2>/dev/null || true)
  [ -n "$ASSOC" ] && [ "$ASSOC" != "None" ] && aws ec2 disassociate-address --region "$R" --association-id "$ASSOC" 2>/dev/null || true
  aws ec2 release-address --region "$R" --allocation-id "$ALLOC" 2>/dev/null \
    && echo "    EIP 已释放" || echo "    （释放失败，请到控制台手动释放，否则会计费）"
fi

# 安全组要等实例完全释放才能删，重试几次
SG=$(aws ec2 describe-security-groups --region "$R" \
      --filters Name=group-name,Values="$NAME-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -n "$SG" ] && [ "$SG" != "None" ]; then
  echo "==> 删除安全组 $SG ..."
  for i in $(seq 1 6); do
    aws ec2 delete-security-group --region "$R" --group-id "$SG" 2>/dev/null && break || sleep 10
  done
fi

echo "==> 删除密钥对 ${NAME}（本地 $SSH_KEY 保留，可手动删）..."
aws ec2 delete-key-pair --region "$R" --key-name "$NAME" --output text >/dev/null || true

echo "==> 完成。EC2 资源已释放，计费归零。"
