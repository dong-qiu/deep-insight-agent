#!/usr/bin/env bash
# 将 GitHub Changelog 作为 t_code_agents 的单一 staged 候选写入生产库。
#
# 先读 docs/plan/specs/ai-swe-source-coverage-2026-09.md：首次 RSS 读取最多接收当前 feed 的
# RSS_MAX_ITEMS（默认 50）条未见条目，接入后须观察 14 天。
# 此脚本故意要求 --apply；不接受“顺手执行”导致的生产配置写入。它只插入缺失的精确配置，或
# 启用 defaults.yaml 中同配置的 staged 源；字段漂移或存在停用原因时失败，绝不覆盖人工调整。
#
# 前置：本机 AWS 凭据和到 ap-southeast-1 的连通性。用法：
#   ./ops/aws/seed-github-changelog-source.sh --apply
set -euo pipefail

if [[ "${1:-}" != "--apply" || "$#" -ne 1 ]]; then
  echo "usage: $0 --apply" >&2
  echo "refusing to write production source configuration without --apply" >&2
  exit 64
fi

region="ap-southeast-1"
instance_id="i-061dc19d7f7ff81ad"

read -r -d '' seed_js <<'JS' || true
"use strict";
const db = new (require("better-sqlite3"))("/data/insight.db");
const configuration = {
  id: "src_github_changelog",
  name: "GitHub Changelog",
  type: "rss",
  endpoint: "https://github.blog/changelog/feed/",
  topic_ids: ["t_code_agents"],
  fetch_interval: "6h",
  backfill: null,
  fetch_mode: "feed",
  content_container: null,
};
const existing = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
).get(configuration.id);
const canonical = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  endpoint: row.endpoint,
  topic_ids: JSON.parse(row.topic_ids),
  fetch_interval: row.fetch_interval,
  backfill: row.backfill ? JSON.parse(row.backfill) : null,
  fetch_mode: row.fetch_mode,
  content_container: row.content_container || null,
});
if (existing) {
  const actual = canonical(existing);
  if (JSON.stringify(actual) !== JSON.stringify(configuration)) {
    console.error("existing source differs from staged configuration; refusing overwrite");
    console.error(JSON.stringify({ expected: configuration, actual }));
    process.exit(1);
  }
  if (existing.disabled_reason) {
    console.error("existing source has a disabled_reason; refusing to bypass it");
    console.error(JSON.stringify({ id: configuration.id, disabled_reason: existing.disabled_reason }));
    process.exit(1);
  }
  if (existing.enabled === 0) {
    db.prepare("UPDATE source SET enabled=1, updated_at=datetime('now') WHERE id=?").run(configuration.id);
    console.log("enabled staged source: " + configuration.id);
  } else if (existing.enabled === 1) {
    console.log("already configured: " + configuration.id);
  } else {
    console.error("existing source has an invalid enabled value; refusing overwrite");
    process.exit(1);
  }
} else {
  db.prepare(`INSERT INTO source
    (id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container)
    VALUES (@id,@name,@type,@endpoint,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container)`)
    .run({ ...configuration, enabled: 1, topic_ids: JSON.stringify(configuration.topic_ids) });
  console.log("inserted and enabled: " + configuration.id);
}
const stored = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
).get(configuration.id);
console.log(JSON.stringify({ ...canonical(stored), enabled: stored.enabled, disabled_reason: stored.disabled_reason }));
JS

payload_b64=$(printf %s "$seed_js" | base64 | tr -d '\n')
remote_command="printf %s $payload_b64 | base64 -d > /tmp/seed-github-changelog.js && NODE_PATH=/app/node_modules node /tmp/seed-github-changelog.js"
parameters=$(jq -nc --arg command "$remote_command" '{commands: ["docker exec -w /app deep-insight-app-1 sh -c '\''" + $command + "'\''"]}')

echo "Submitting guarded staged-source write through SSM..."
command_id=$(aws ssm send-command \
  --region "$region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)
echo "CommandId=$command_id"

state="Pending"
for _ in $(seq 1 30); do
  state=$(aws ssm get-command-invocation \
    --region "$region" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query Status \
    --output text 2>/dev/null || echo Pending)
  case "$state" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  sleep 2
done

echo "Status=$state"
aws ssm get-command-invocation \
  --region "$region" \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --query StandardOutputContent \
  --output text
stderr=$(aws ssm get-command-invocation \
  --region "$region" \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --query StandardErrorContent \
  --output text)
[[ -z "$stderr" ]] || { echo "--- stderr ---" >&2; echo "$stderr" >&2; }
[[ "$state" == "Success" ]]
