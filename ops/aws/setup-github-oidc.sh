#!/usr/bin/env bash
# 为 GitHub Actions → AWS SSM 生产部署创建最小 OIDC 权限。
# 用法：ops/aws/setup-github-oidc.sh
#      SET_GITHUB_VARIABLES=1 ops/aws/setup-github-oidc.sh  # 同时写入仓库 Actions variables
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091 # operator-local config.sh is gitignored
source "$ROOT/ops/aws/config.sh"

repository="${GITHUB_REPOSITORY:-dong-qiu/deep-insight-agent}"
instance_id="${PROD_INSTANCE_ID:-$(<"$ROOT/ops/aws/.vm-id")}"
role_name="${AWS_NAME}-github-production-deploy"
policy_name="${AWS_NAME}-github-production-ssm-deploy"
account_id="$(aws sts get-caller-identity --query Account --output text)"
provider_arn="arn:aws:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com"
role_arn="arn:aws:iam::${account_id}:role/${role_name}"
instance_arn="arn:aws:ec2:${AWS_REGION}:${account_id}:instance/${instance_id}"
document_arn="arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript"

if ! provider_json="$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" 2>/dev/null)"; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
elif ! jq -e '.ClientIDList | index("sts.amazonaws.com")' <<<"$provider_json" >/dev/null; then
  aws iam add-client-id-to-open-id-connect-provider \
    --open-id-connect-provider-arn "$provider_arn" \
    --client-id sts.amazonaws.com
fi

trust_policy="$(jq -n --arg provider "$provider_arn" --arg repository "$repository" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: {Federated: $provider},
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": ("repo:" + $repository + ":environment:production")
      }
    }
  }]
}')"

permissions_policy="$(jq -n --arg instance "$instance_arn" --arg document "$document_arn" --arg region "$AWS_REGION" --arg account "$account_id" '{
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "RunDeployCommandOnlyOnProduction",
      Effect: "Allow",
      Action: "ssm:SendCommand",
      Resource: [$document, $instance]
    },
    {
      Sid: "ReadOwnCommandResult",
      Effect: "Allow",
      Action: "ssm:GetCommandInvocation",
      Resource: ("arn:aws:ssm:" + $region + ":" + $account + ":*")
    }
  ]
}')"

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$role_name" --policy-document "$trust_policy"
else
  aws iam create-role --role-name "$role_name" --assume-role-policy-document "$trust_policy" \
    --description "GitHub Actions production image deployment for ${repository}" >/dev/null
fi
aws iam put-role-policy --role-name "$role_name" --policy-name "$policy_name" --policy-document "$permissions_policy"

printf 'Create these GitHub Actions repository variables if not using SET_GITHUB_VARIABLES=1:\n'
printf '  AWS_REGION=%s\n  AWS_DEPLOY_ROLE_ARN=%s\n  PROD_INSTANCE_ID=%s\n' "$AWS_REGION" "$role_arn" "$instance_id"

if [[ "${SET_GITHUB_VARIABLES:-0}" == "1" ]]; then
  command -v gh >/dev/null || { echo 'SET_GITHUB_VARIABLES=1 requires GitHub CLI' >&2; exit 1; }
  gh variable set AWS_REGION --repo "$repository" --body "$AWS_REGION"
  gh variable set AWS_DEPLOY_ROLE_ARN --repo "$repository" --body "$role_arn"
  gh variable set PROD_INSTANCE_ID --repo "$repository" --body "$instance_id"
fi
