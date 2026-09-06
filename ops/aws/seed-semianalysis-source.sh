#!/usr/bin/env bash
# 将生产中的 SemiAnalysis 从已失效的旧 feed 精确迁移至站方当前 newsletter feed。
#
# 这不是通用 upsert：只有现有行与已审计的旧配置逐字段相符、仍处于人工启用且没有停用原因时，
# 才只更新 endpoint。配置已是新值时幂等成功；任何其他漂移均失败，绝不覆盖人工调整。
# 不删除既有 ContentItem；新 feed 首轮仍受 RSS_MAX_ITEMS 限制。
#
# 前置：先运行 ./ops/aws/probe-sources.sh 确认生产出口对 newsletter feed 的 robots 与可达性。
# 用法：./ops/aws/seed-semianalysis-source.sh --apply
set -euo pipefail

if [[ "${1:-}" != "--apply" || "$#" -ne 1 ]]; then
  echo "usage: $0 --apply" >&2
  echo "refusing to write production source configuration without --apply" >&2
  exit 64
fi

region="ap-southeast-1"
instance_id="i-061dc19d7f7ff81ad"

read -r -d '' migration_js <<'JS' || true
"use strict";
const db = new (require("better-sqlite3"))("/data/insight.db");
const legacy = {
  id: "src_semianalysis", name: "SemiAnalysis", type: "rss",
  endpoint: "https://www.semianalysis.com/feed", topic_ids: ["t_ai_industry"],
  fetch_interval: "24h", backfill: null, fetch_mode: "feed", content_container: null,
};
const desired = { ...legacy, endpoint: "https://newsletter.semianalysis.com/feed" };
const row = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
).get(desired.id);
if (!row) {
  console.error("production source missing; refusing to insert a new source from a migration script");
  process.exit(1);
}
const canonical = (r) => ({
  id: r.id, name: r.name, type: r.type, endpoint: r.endpoint,
  topic_ids: JSON.parse(r.topic_ids), fetch_interval: r.fetch_interval,
  backfill: r.backfill ? JSON.parse(r.backfill) : null,
  fetch_mode: r.fetch_mode, content_container: r.content_container || null,
});
const actual = canonical(row);
if (row.disabled_reason || row.enabled !== 1) {
  console.error("source is not an unmodified, manually enabled source; refusing migration");
  console.error(JSON.stringify({ enabled: row.enabled, disabled_reason: row.disabled_reason }));
  process.exit(1);
}
if (JSON.stringify(actual) === JSON.stringify(desired)) {
  console.log("already migrated: " + desired.id);
} else if (JSON.stringify(actual) === JSON.stringify(legacy)) {
  db.prepare("UPDATE source SET endpoint=?, updated_at=datetime('now') WHERE id=?").run(desired.endpoint, desired.id);
  console.log("migrated source endpoint: " + desired.id);
} else {
  console.error("existing source differs from audited legacy/desired configuration; refusing overwrite");
  console.error(JSON.stringify({ legacy, desired, actual }));
  process.exit(1);
}
const stored = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
).get(desired.id);
console.log(JSON.stringify({ ...canonical(stored), enabled: stored.enabled, disabled_reason: stored.disabled_reason }));
JS

payload_b64=$(printf %s "$migration_js" | base64 | tr -d '\n')
remote_command="printf %s $payload_b64 | base64 -d > /tmp/seed-semianalysis.js && NODE_PATH=/app/node_modules node /tmp/seed-semianalysis.js"
parameters=$(jq -nc --arg command "$remote_command" '{commands: ["docker exec -w /app deep-insight-app-1 sh -c '\''" + $command + "'\''"]}')

echo "Submitting guarded SemiAnalysis source migration through SSM..."
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
