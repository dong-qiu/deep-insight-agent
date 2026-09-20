#!/usr/bin/env bash
# Provision/check the dedicated controlled store for A1 v2 source snapshots.
# It intentionally has no application role: only an explicitly authorized evaluator identity may
# write source bodies. Default --check is read-only; --apply creates durable AWS resources.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in --check|--apply) ;; *) echo "用法：$0 [--check|--apply]" >&2; exit 2;; esac

AWS_REGION="${A1_EVAL_SNAPSHOT_AWS_REGION:-${AWS_REGION:-ap-southeast-1}}"
AWS_NAME="${A1_EVAL_SNAPSHOT_AWS_NAME:-${AWS_NAME:-deep-insight}}"
RETENTION_DAYS="${A1_EVAL_SNAPSHOT_RETENTION_DAYS:-90}"
[ "$RETENTION_DAYS" = "90" ] || { echo "拒绝：A1 受控 snapshot 的默认 Compliance 保留期固定为 90 天" >&2; exit 2; }
export AWS_DEFAULT_REGION="$AWS_REGION"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${A1_EVAL_SNAPSHOT_BUCKET:-${AWS_NAME}-a1-eval-snapshots-${ACCOUNT_ID}}"
KMS_ALIAS="alias/${AWS_NAME}-a1-eval-snapshot"
LIFECYCLE_ID="expire-a1-eval-snapshots-after-lock"

require_bucket() {
  aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || {
    echo "FAIL: controlled A1 snapshot bucket 不存在；经授权后运行 --apply" >&2
    exit 1
  }
}

check() {
  require_bucket
  local key_arn lock mode days versioning encryption lifecycle
  key_arn="$(aws kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text)"
  lock="$(aws s3api get-object-lock-configuration --bucket "$BUCKET" --output json)"
  mode="$(aws s3api get-object-lock-configuration --bucket "$BUCKET" --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text)"
  days="$(aws s3api get-object-lock-configuration --bucket "$BUCKET" --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text)"
  versioning="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)"
  encryption="$(aws s3api get-bucket-encryption --bucket "$BUCKET" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault' --output json)"
  lifecycle="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --query "Rules[?ID=='${LIFECYCLE_ID}'].Expiration.Days | [0]" --output text)"
  [ "$mode" = "COMPLIANCE" ] && [ "$days" = "$RETENTION_DAYS" ] || { echo "FAIL: Object Lock 必须为 Compliance/${RETENTION_DAYS}d" >&2; exit 1; }
  [ "$versioning" = "Enabled" ] || { echo "FAIL: bucket versioning 未启用" >&2; exit 1; }
  printf '%s' "$encryption" | grep -q '"SSEAlgorithm": "aws:kms"' || { echo "FAIL: bucket 默认加密不是 SSE-KMS" >&2; exit 1; }
  printf '%s' "$encryption" | grep -q "$key_arn" || { echo "FAIL: bucket 默认加密未使用专用 A1 snapshot CMK" >&2; exit 1; }
  [ "$lifecycle" = "91" ] || { echo "FAIL: lifecycle 未在 lock 到期后第 91 天受控清理" >&2; exit 1; }
  aws s3api get-public-access-block --bucket "$BUCKET" --query PublicAccessBlockConfiguration --output json | grep -q '"BlockPublicAcls": true' || { echo "FAIL: public access block 未完整启用" >&2; exit 1; }
  printf '%s' "$lock" | grep -q '"ObjectLockEnabled": "Enabled"' || { echo "FAIL: Object Lock 未启用" >&2; exit 1; }
  echo "PASS: s3://${BUCKET} is private, versioned, SSE-KMS encrypted, and Object-Lock Compliance/${RETENTION_DAYS}d."
}

if [ "$MODE" = "--check" ]; then
  check
  exit 0
fi

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket 已存在；不会尝试重建或缩短任何 Object Lock 保留期。"
else
  aws s3api create-bucket --bucket "$BUCKET" --object-lock-enabled-for-bucket \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
fi

KEY_ARN="$(aws kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)"
if [ -z "$KEY_ARN" ] || [ "$KEY_ARN" = "None" ]; then
  KEY_ARN="$(aws kms create-key --description "${AWS_NAME} A1 controlled evaluation snapshot key" --query KeyMetadata.Arn --output text)"
  aws kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KEY_ARN"
fi
aws kms enable-key-rotation --key-id "$KEY_ARN"
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"${KEY_ARN}\"},\"BucketKeyEnabled\":true}]}"
aws s3api put-object-lock-configuration --bucket "$BUCKET" --object-lock-configuration \
  "{\"ObjectLockEnabled\":\"Enabled\",\"Rule\":{\"DefaultRetention\":{\"Mode\":\"COMPLIANCE\",\"Days\":${RETENTION_DAYS}}}}"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  "{\"Rules\":[{\"ID\":\"${LIFECYCLE_ID}\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"Expiration\":{\"Days\":91},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":91},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":7}}]}"

POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT
cat >"$POLICY_FILE" <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}},
 {"Sid":"DenyNonKmsObjectPuts","Effect":"Deny","Principal":"*","Action":"s3:PutObject","Resource":"arn:aws:s3:::${BUCKET}/*","Condition":{"StringNotEquals":{"s3:x-amz-server-side-encryption":"aws:kms"}}},
 {"Sid":"DenyWrongKmsKey","Effect":"Deny","Principal":"*","Action":"s3:PutObject","Resource":"arn:aws:s3:::${BUCKET}/*","Condition":{"StringNotEquals":{"s3:x-amz-server-side-encryption-aws-kms-key-id":"${KEY_ARN}"}}}
]}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://${POLICY_FILE}"
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging \
  "TagSet=[{Key=purpose,Value=a1-controlled-evaluation-snapshots},{Key=retention,Value=${RETENTION_DAYS}d},{Key=contains,Value=third-party-source-content}]"

check
