#!/usr/bin/env bash
# Promote only the audited Pragmatic Engineer mixed feed from off -> observe.
#
# It never enables transcript requests.  The deployed image must already contain the
# `substack_episode_hydration` adapter and ADR-0027 migration.  Usage: $0 --apply
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
const expected = {
  id: "src_pragmatic_eng", name: "The Pragmatic Engineer", type: "rss",
  endpoint: "https://newsletter.pragmaticengineer.com/feed", topic_ids: ["t_code_agents"],
  fetch_interval: "24h", backfill: null, fetch_mode: "feed", content_container: null,
};
const desired = {
  transcript_mode: "observe", transcript_strategy: "relevant_only", transcript_max_items_per_run: 1,
  transcript_max_bytes_per_run: 2 * 1024 * 1024, transcript_timeout_budget_ms: 20_000, transcript_host_qps: 0.25,
};
const row = db.prepare(`SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,
  disabled_reason,transcript_mode,transcript_strategy,transcript_max_items_per_run,transcript_max_bytes_per_run,
  transcript_timeout_budget_ms,transcript_host_qps FROM source WHERE id=?`).get(expected.id);
if (!row) { console.error("production Pragmatic source missing"); process.exit(1); }
const canonical = (r) => ({
  id: r.id, name: r.name, type: r.type, endpoint: r.endpoint, topic_ids: JSON.parse(r.topic_ids),
  fetch_interval: r.fetch_interval, backfill: r.backfill ? JSON.parse(r.backfill) : null,
  fetch_mode: r.fetch_mode, content_container: r.content_container || null,
});
const policy = (r) => ({
  transcript_mode: r.transcript_mode, transcript_strategy: r.transcript_strategy,
  transcript_max_items_per_run: r.transcript_max_items_per_run, transcript_max_bytes_per_run: r.transcript_max_bytes_per_run,
  transcript_timeout_budget_ms: r.transcript_timeout_budget_ms, transcript_host_qps: r.transcript_host_qps,
});
if (JSON.stringify(canonical(row)) !== JSON.stringify(expected)) {
  console.error("Pragmatic source differs from the audited configuration; refusing overwrite");
  console.error(JSON.stringify({ expected, actual: canonical(row) })); process.exit(1);
}
if (row.enabled !== 1 || row.disabled_reason) {
  console.error("Pragmatic source is disabled or carries an operator reason; refusing overwrite");
  console.error(JSON.stringify({ enabled: row.enabled, disabled_reason: row.disabled_reason })); process.exit(1);
}
if (JSON.stringify(policy(row)) === JSON.stringify(desired)) {
  console.log(JSON.stringify({ action: "already_observing", source_id: expected.id, policy: desired }));
} else if (row.transcript_mode === "off") {
  db.prepare(`UPDATE source SET transcript_mode=@transcript_mode,transcript_strategy=@transcript_strategy,
    transcript_max_items_per_run=@transcript_max_items_per_run,transcript_max_bytes_per_run=@transcript_max_bytes_per_run,
    transcript_timeout_budget_ms=@transcript_timeout_budget_ms,transcript_host_qps=@transcript_host_qps,updated_at=datetime('now') WHERE id=@id`)
    .run({ ...desired, id: expected.id });
  console.log(JSON.stringify({ action: "set_observe", source_id: expected.id, policy: desired }));
} else {
  console.error("Pragmatic policy is neither audited off nor desired observe; refusing downgrade/overwrite");
  console.error(JSON.stringify({ actual: policy(row), desired })); process.exit(1);
}
JS

payload_b64=$(printf %s "$migration_js" | base64 | tr -d '\n')
remote_command="printf %s $payload_b64 | base64 -d > /tmp/set-pragmatic-transcript-observe.js && NODE_PATH=/app/node_modules node /tmp/set-pragmatic-transcript-observe.js"
parameters=$(jq -nc --arg command "$remote_command" '{commands: ["docker exec -w /app deep-insight-app-1 sh -c '\''" + $command + "'\''"]}')

echo "Submitting guarded Pragmatic observe transition through SSM..."
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
