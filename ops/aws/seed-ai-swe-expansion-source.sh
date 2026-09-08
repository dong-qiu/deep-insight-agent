#!/usr/bin/env bash
# Atomically enable the audited AI-SWE staged-source cohort in production.
#
# This is deliberately not a generic upsert. It accepts only --apply-all and writes only the
# three configurations audited in docs/plan/specs/ai-swe-source-coverage-2026-09.md. Existing
# rows must match exactly and have no manual disabled_reason; any drift rejects and rolls back
# the complete cohort. New rows are inserted with the same exact configuration.
set -euo pipefail

if [[ "${1:-}" != "--apply-all" || "$#" -ne 1 ]]; then
  echo "usage: $0 --apply-all" >&2
  echo "refusing to write production source configuration without explicit cohort approval" >&2
  exit 64
fi

region="ap-southeast-1"
instance_id="i-061dc19d7f7ff81ad"

read -r -d '' seed_js <<'JS' || true
"use strict";
const db = new (require("better-sqlite3"))("/data/insight.db");
const configurations = [
  {
    id: "src_openai_codex_releases", name: "OpenAI Codex Releases", type: "rss",
    endpoint: "https://github.com/openai/codex/releases.atom", topic_ids: ["t_code_agents"],
    fetch_interval: "12h", backfill: null, fetch_mode: "full_text", content_container: "repository-content",
  },
  {
    id: "src_cursor_changelog", name: "Cursor Changelog", type: "rss",
    endpoint: "https://cursor.com/changelog/rss.xml", topic_ids: ["t_code_agents"],
    fetch_interval: "12h", backfill: null, fetch_mode: "feed", content_container: null,
  },
  {
    id: "src_openhands_releases", name: "OpenHands Releases", type: "rss",
    endpoint: "https://github.com/OpenHands/OpenHands/releases.atom", topic_ids: ["t_code_agents"],
    fetch_interval: "24h", backfill: null, fetch_mode: "feed", content_container: null,
  },
];
const canonical = (row) => ({
  id: row.id, name: row.name, type: row.type, endpoint: row.endpoint,
  topic_ids: JSON.parse(row.topic_ids), fetch_interval: row.fetch_interval,
  backfill: row.backfill ? JSON.parse(row.backfill) : null,
  fetch_mode: row.fetch_mode, content_container: row.content_container || null,
});
if (new Set(configurations.map((configuration) => configuration.id)).size !== 3) {
  throw new Error("AI-SWE cohort has duplicate source ids");
}

const select = db.prepare(
  "SELECT id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container,disabled_reason FROM source WHERE id=?",
);
const enable = db.prepare("UPDATE source SET enabled=1, updated_at=datetime('now') WHERE id=?");
const insert = db.prepare(`INSERT INTO source
  (id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container)
  VALUES (@id,@name,@type,@endpoint,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container)`);

let actions;
try {
  actions = db.transaction(() => {
    // Validate every row before changing anything. The initial launch is coherent only
    // when no member is enabled; a fully enabled cohort is the sole idempotent retry.
    const states = configurations.map((configuration) => {
      const existing = select.get(configuration.id);
      if (!existing) return { configuration, existing: null };
      const actual = canonical(existing);
      if (JSON.stringify(actual) !== JSON.stringify(configuration)) {
        throw new Error(`source configuration drift for ${configuration.id}: ${JSON.stringify({ expected: configuration, actual })}`);
      }
      if (existing.disabled_reason) {
        throw new Error(`manual disablement blocks ${configuration.id}: ${existing.disabled_reason}`);
      }
      if (existing.enabled !== 0 && existing.enabled !== 1) {
        throw new Error(`invalid enabled value for ${configuration.id}`);
      }
      return { configuration, existing };
    });
    const enabledBefore = states.filter(({ existing }) => existing?.enabled === 1).length;
    const allAlreadyEnabled = enabledBefore === configurations.length && states.every(({ existing }) => existing);
    if (enabledBefore !== 0 && !allAlreadyEnabled) {
      throw new Error("non-cohort initial state: expected no sources enabled or all three already enabled");
    }
    if (allAlreadyEnabled) return configurations.map(({ id }) => ({ id, action: "already_enabled" }));
    return states.map(({ configuration, existing }) => {
    if (!existing) {
      insert.run({ ...configuration, enabled: 1, topic_ids: JSON.stringify(configuration.topic_ids) });
      return { id: configuration.id, action: "inserted" };
    }
    enable.run(configuration.id);
    return { id: configuration.id, action: "enabled" };
    });
  })();
} catch (error) {
  console.error("AI-SWE cohort not changed: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

const stored = configurations.map((configuration) => {
  const row = select.get(configuration.id);
  return { ...canonical(row), enabled: row.enabled, disabled_reason: row.disabled_reason };
});
console.log(JSON.stringify({ actions, stored }));
JS

payload_b64=$(printf %s "$seed_js" | base64 | tr -d '\n')
remote_command="printf %s $payload_b64 | base64 -d > /tmp/seed-ai-swe-expansion.js && NODE_PATH=/app/node_modules node /tmp/seed-ai-swe-expansion.js"
parameters=$(jq -nc --arg command "$remote_command" '{commands: ["docker exec -w /app deep-insight-app-1 sh -c '\''" + $command + "'\''"]}')

echo "Submitting guarded AI-SWE cohort write through SSM..."
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
