#!/usr/bin/env bash
# 经人工相关性复审后，停用生产中的 Google Research Blog（不删除历史内容）。
# 仅接受精确的当前配置；已被人工调整、已停用或字段漂移时失败，杜绝批量/盲目下线。
# 用法：./ops/aws/disable-google-research-source.sh --apply
set -euo pipefail

if [[ "${1:-}" != "--apply" || "$#" -ne 1 ]]; then
  echo "usage: $0 --apply" >&2
  echo "refusing to write production source configuration without --apply" >&2
  exit 64
fi

region="ap-southeast-1"
instance_id="i-061dc19d7f7ff81ad"

read -r -d '' disable_js <<'JS' || true
"use strict";
const db = new (require("better-sqlite3"))("/data/insight.db");
const expected = {
  id: "src_google_research", name: "Google Research Blog", type: "rss",
  endpoint: "https://research.google/blog/rss/", topic_ids: ["t_code_agents"],
  fetch_interval: "6h", backfill: null, fetch_mode: "full_text", content_container: "rich_text",
};
const row = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
).get(expected.id);
if (!row) { console.error("production source missing"); process.exit(1); }
const canonical = (r) => ({
  id: r.id, name: r.name, type: r.type, endpoint: r.endpoint,
  topic_ids: JSON.parse(r.topic_ids), fetch_interval: r.fetch_interval,
  backfill: r.backfill ? JSON.parse(r.backfill) : null,
  fetch_mode: r.fetch_mode, content_container: r.content_container || null,
});
if (JSON.stringify(canonical(row)) !== JSON.stringify(expected)) {
  console.error("source differs from reviewed configuration; refusing to disable");
  console.error(JSON.stringify({ expected, actual: canonical(row) }));
  process.exit(1);
}
if (row.enabled !== 1 || row.disabled_reason) {
  console.error("source is already disabled or carries an operator reason; refusing overwrite");
  console.error(JSON.stringify({ enabled: row.enabled, disabled_reason: row.disabled_reason }));
  process.exit(1);
}
db.prepare("UPDATE source SET enabled=0, disabled_reason=?, disabled_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
  .run("manual_relevance_review_2026_09", expected.id);
const stored = db.prepare("SELECT id,enabled,disabled_reason,disabled_at FROM source WHERE id=?").get(expected.id);
console.log(JSON.stringify(stored));
JS

payload_b64=$(printf %s "$disable_js" | base64 | tr -d '\n')
remote_command="printf %s $payload_b64 | base64 -d > /tmp/disable-google-research.js && NODE_PATH=/app/node_modules node /tmp/disable-google-research.js"
parameters=$(jq -nc --arg command "$remote_command" '{commands: ["docker exec -w /app deep-insight-app-1 sh -c '\''" + $command + "'\''"]}')

echo "Submitting guarded Google Research disable through SSM..."
command_id=$(aws ssm send-command --region "$region" --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript --parameters "$parameters" --query 'Command.CommandId' --output text)
echo "CommandId=$command_id"

state="Pending"
for _ in $(seq 1 30); do
  state=$(aws ssm get-command-invocation --region "$region" --command-id "$command_id" \
    --instance-id "$instance_id" --query Status --output text 2>/dev/null || echo Pending)
  case "$state" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 2
done
echo "Status=$state"
aws ssm get-command-invocation --region "$region" --command-id "$command_id" \
  --instance-id "$instance_id" --query StandardOutputContent --output text
stderr=$(aws ssm get-command-invocation --region "$region" --command-id "$command_id" \
  --instance-id "$instance_id" --query StandardErrorContent --output text)
[[ -z "$stderr" ]] || { echo "--- stderr ---" >&2; echo "$stderr" >&2; }
[[ "$state" == "Success" ]]
