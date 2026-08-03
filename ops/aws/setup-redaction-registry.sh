#!/usr/bin/env bash
# P0a redaction registry 的显式部署/验收器。默认 --check（只读）；只有 --apply 才会创建 S3/KMS/IAM 策略。
# 不创建 Secrets Manager HMAC secret 或 recovery role：两者的值/信任主体属于安全管理员职责，必须预先提供。
set -euo pipefail
cd "$(dirname "$0")"
source config.sh

MODE="${1:---check}"
case "$MODE" in --check|--apply) ;; *) echo "用法：$0 [--check|--apply]" >&2; exit 2;; esac
export AWS_DEFAULT_REGION="$AWS_REGION"

: "${REDACTION_HMAC_SECRET_ARN:?必须配置版本固定的 REDACTION_HMAC_SECRET_ARN}"
: "${REDACTION_HMAC_KEY_VERSION:?必须配置 REDACTION_HMAC_KEY_VERSION}"
: "${REDACTION_RECOVERY_ROLE:?必须配置独立的 REDACTION_RECOVERY_ROLE 名称}"

[ "$AWS_REGION" = "ap-southeast-1" ] || { echo "拒绝：registry 规格固定在 ap-southeast-1，当前为 $AWS_REGION" >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${REDACTION_REGISTRY_BUCKET:-${AWS_NAME}-redaction-registry-${ACCOUNT_ID}}"
APP_ROLE="${REDACTION_APP_ROLE:-${AWS_NAME}-ssm}"
KMS_ALIAS="alias/${AWS_NAME}-redaction-registry"
RECOVERY_ROLE_ARN="$(aws iam get-role --role-name "$REDACTION_RECOVERY_ROLE" --query 'Role.Arn' --output text 2>/dev/null || true)"
[ -n "$RECOVERY_ROLE_ARN" ] && [ "$RECOVERY_ROLE_ARN" != "None" ] || { echo "FAIL: recovery role 不存在（信任策略须由安全管理员预建）" >&2; exit 1; }

echo "registry bucket : $BUCKET"
echo "app role        : $APP_ROLE"
echo "recovery role   : $REDACTION_RECOVERY_ROLE"
echo "hmac version    : $REDACTION_HMAC_KEY_VERSION"

if [ "$MODE" = "--check" ]; then
  aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || { echo "FAIL: bucket 不存在（经审批后运行 --apply）" >&2; exit 1; }
  KEY_ARN="$(aws kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text)"
  aws s3api get-object-lock-configuration --bucket "$BUCKET" --query 'ObjectLockConfiguration.Rule.DefaultRetention' --output json
  aws s3api get-bucket-versioning --bucket "$BUCKET" --output json
  aws s3api get-public-access-block --bucket "$BUCKET" --output json
  aws s3api get-bucket-encryption --bucket "$BUCKET" --output json | grep -q "$KEY_ARN" || { echo "FAIL: bucket 默认加密未使用 registry CMK" >&2; exit 1; }
  echo "PASS: bucket/KMS 基础配置存在；另请用 IAM policy simulator 验证 app role 无 GetObject/DeleteObject/Decrypt。"
  exit 0
fi

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket 已存在；Object Lock 只能在创建时启用，以下仅补齐可变配置。"
else
  aws s3api create-bucket --bucket "$BUCKET" --object-lock-enabled-for-bucket \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
fi

KEY_ARN="$(aws kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)"
if [ -z "$KEY_ARN" ] || [ "$KEY_ARN" = "None" ]; then
  KEY_ARN="$(aws kms create-key --description "${AWS_NAME} redaction registry envelope key" --query KeyMetadata.Arn --output text)"
  aws kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KEY_ARN"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"${KEY_ARN}\"},\"BucketKeyEnabled\":true}]}"
aws s3api put-object-lock-configuration --bucket "$BUCKET" --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":100}}}'

TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
cat >"$TMP_DIR/app.json" <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"PutImmutableRegistryRecords","Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::${BUCKET}/records/*"},
 {"Sid":"EnvelopeEncryptOnly","Effect":"Allow","Action":["kms:GenerateDataKey","kms:Encrypt"],"Resource":"${KEY_ARN}"},
 {"Sid":"ReadVersionedHmacOnly","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"${REDACTION_HMAC_SECRET_ARN}"},
 {"Sid":"DenyRegistryReadsAndMutation","Effect":"Deny","Action":["s3:GetObject","s3:DeleteObject","s3:PutObjectRetention","s3:BypassGovernanceRetention"],"Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"]},
 {"Sid":"DenyRegistryDecrypt","Effect":"Deny","Action":"kms:Decrypt","Resource":"${KEY_ARN}"}
]}
JSON
cat >"$TMP_DIR/recovery.json" <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"ReadRegistryOnly","Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::${BUCKET}"},
 {"Sid":"ReadRegistryObjects","Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::${BUCKET}/records/*"},
 {"Sid":"DecryptRegistryOnly","Effect":"Allow","Action":"kms:Decrypt","Resource":"${KEY_ARN}"},
 {"Sid":"ReadVersionedHmacOnly","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"${REDACTION_HMAC_SECRET_ARN}"},
 {"Sid":"DenyBusinessMutation","Effect":"Deny","Action":["s3:DeleteObject","s3:PutObject","s3:PutObjectRetention","s3:BypassGovernanceRetention"],"Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"]}
]}
JSON
aws iam put-role-policy --role-name "$APP_ROLE" --policy-name redaction-registry-append-only --policy-document "file://$TMP_DIR/app.json"
aws iam put-role-policy --role-name "$REDACTION_RECOVERY_ROLE" --policy-name redaction-registry-recovery --policy-document "file://$TMP_DIR/recovery.json"

echo "已配置 registry。恢复必须在独立 recovery identity 中运行（不得由 app instance role AssumeRole）；将 REDACTION_RECOVERY_ROLE_ARN=${RECOVERY_ROLE_ARN} 写入受控恢复 runner 环境。下一步以 --check 验收，并用 IAM policy simulator 验证 app role 无 GetObject/DeleteObject/Decrypt/AssumeRole。"
