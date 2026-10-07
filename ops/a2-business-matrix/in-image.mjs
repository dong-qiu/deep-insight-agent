// Test harness only, mounted outside /app. Never substitutes any released application code.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { revision } from "./contracts.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const Database = createRequire("/app/package.json")("better-sqlite3");
export function dbAt(path = process.env.DB_PATH) {
  const db = new Database(path, { fileMustExist: true }); db.pragma("foreign_keys=ON"); return db;
}
export function bundleIdentity() {
  assert.equal(JSON.parse(readFileSync("/app/build-info.json")).git_sha, revision);
  const entries = [];
  function visit(path) {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else entries.push([path, hash(readFileSync(path))]);
  }
  for (const path of ["/app/server.js", "/app/build-info.json", "/app/.next/server", "/app/ops/run-provenance-migrations.mjs", "/app/ops/record-deployment.mjs", "/app/config/defaults.yaml"]) visit(path);
  return { revision, sha256: hash(JSON.stringify(entries)), files: entries.length };
}
export function snapshot(db) {
  const all = sql => db.prepare(sql).all();
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  return { ledger: all("SELECT version,checksum FROM schema_migration ORDER BY version"),
    deployments: all("SELECT id,git_sha,image_digest,actor FROM deployment_record ORDER BY id"),
    topics: all("SELECT id,name,keywords,language,brief_schedule,enabled,facets FROM topic ORDER BY id"),
    users: all("SELECT email,role FROM app_user ORDER BY email"),
    leads: all("SELECT id,topic_id,status,canonical_key FROM tech_lead ORDER BY id"),
    reports: all("SELECT id,status,topic_id,insight_ids,prev_report_id,body_path FROM report ORDER BY id"),
    traces: all("SELECT id,scope_kind,topic_id,request_id,status,summary FROM generation_trace ORDER BY id"),
    events: all("SELECT trace_id,sequence,event_type,actor_type,actor_id FROM generation_event ORDER BY trace_id,sequence"),
    refs: all("SELECT * FROM generation_entity_ref ORDER BY rowid"),
    leases: all("SELECT trace_id,state FROM generation_lease ORDER BY id"),
    requests: all("SELECT id,trace_id,state FROM generation_trace_request ORDER BY id"),
    effects: all("SELECT id,kind,status,raw_content_id,report_id,artifact_manifest FROM generation_effect ORDER BY id"),
    runs: all("SELECT id,status FROM run ORDER BY id"),
    model_attempts: all("SELECT attempt_id FROM model_usage_attempt ORDER BY attempt_id"),
    dispatch: all("SELECT id,state FROM generation_dispatch ORDER BY id") };
}
export const topicId = "t_matrix";
export const reportIds = ["rep_b1c2d3e4", "rep_0123456789abcdef0123456789abcdef"];
export const cases = ["valid_old", "valid_long", "blocked", "unchecked", "flagged", "reachfail", "legacygate", "nocounter", "statementbad", "audithash", "unknown", "misbound", "body_envelope", "missing", "corrupt", "unreadable", "plain"];
export const leadId = mode => mode === "valid_old" ? "lead_a1b2c3d4" : mode === "valid_long" ? "lead_0123456789abcdef0123456789abcdef" : `lead_${mode}`;
export const insightId = mode => mode === "valid_old" ? "ins_a1b2c3d4" : mode === "valid_long" ? "ins_0123456789abcdef0123456789abcdef" : `ins_${mode}`;
export const expectedLeads = [leadId("valid_old"), leadId("valid_long")];
export const expectedInsights = [insightId("valid_old"), insightId("valid_long")];
