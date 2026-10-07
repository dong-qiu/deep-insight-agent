import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dbAt, hash, snapshot, bundleIdentity, cases, leadId, insightId, topicId, reportIds } from "./in-image.mjs";

const db = dbAt(), now = new Date().toISOString();
const ledger = db.prepare("SELECT version,checksum FROM schema_migration ORDER BY version").all();
assert.equal(ledger.length, 48);
const insert = (table, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(fields));
};
mkdirSync("/data/raw", { recursive: true }); mkdirSync("/data/reports", { recursive: true });
// Historical defaults remain synthetic, but cannot trigger daily staleness notifications.
db.prepare("UPDATE topic SET enabled=0 WHERE id='t_old'").run();
insert("topic", { id: topicId, name: "A2 synthetic reader", keywords: '["synthetic"]', language: "en", brief_schedule: "weekly", facets: '["domain:software-engineering"]' });
insert("source", { id: "src_matrix", name: "A2 synthetic", type: "rss", endpoint: "https://example.test/synthetic", topic_ids: JSON.stringify([topicId]), fetch_interval: "6h", enabled: 0 });
const rawManifest = [];
for (const mode of cases) {
  const contentId = `ci_${mode}`, iid = insightId(mode), bid = `batch_${mode}`;
  const quote = `Atlas synthetic frozen matrix ${mode}.`, body = quote;
  const envelope = mode === "plain" ? body : JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed",
    source_body: mode === "body_envelope" ? `${body} altered` : body, source_body_kind: "article", source_item_raw: "<synthetic />", structured_body_sha256: hash(body) });
  const digest = hash(envelope), target = `${contentId}.${digest}.txt`, ref = `raw/${target}`;
  if (mode !== "missing") {
    writeFileSync(`/data/${ref}`, mode === "corrupt" ? "corrupt" : envelope);
    if (mode === "unreadable") chmodSync(`/data/${ref}`, 0);
  }
  rawManifest.push({ mode, ref, sha256: digest, bytes: Buffer.byteLength(envelope) });
  // reader_eligible=1 even for unknown isolates the effect-status gate. It is intentionally
  // inconsistent with a legitimate pending archive and must remain hidden after startup.
  insert("content_item", { id: contentId, source_id: "src_matrix", url: `https://example.test/${contentId}`, title: contentId, fetched_at: now, reader_eligible: 1,
    published_at: now, language: "en", topic_ids: JSON.stringify([topicId]), body, body_kind: "article", raw_ref: ref, content_hash: hash(body), fetch_status: "ok" });
  insert("generation_effect", { id: `effect_${mode}`, raw_content_id: contentId, kind: "raw_archive", status: mode === "unknown" ? "unknown" : "committed",
    idempotency_key: `raw_archive:${contentId}:${digest}`, artifact_manifest: JSON.stringify([{ target, sha256: mode === "misbound" ? "0".repeat(64) : digest, size: Buffer.byteLength(envelope) }]),
    publication_payload: "{}", created_at: now, updated_at: now });
  insert("analysis_batch", { id: bid, topic_id: topicId, time_window: "{}", status: "done", display_coverage_state: "audited", display_projection_version: "source_quote_v1" });
  insert("insight", { id: iid, batch_id: bid, topic_id: topicId, type: "aggregation", statement: mode === "statementbad" ? `${quote} inflated` : quote,
    statement_citation_index: 2, importance: 3, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", source_count: 1,
    multi_source: 0, time_window: "{}", language: "en", entities: '[{"name":"Atlas","type":"organization"}]', tags: "[]" });
  for (const index of [0, 1]) insert("citation", { insight_id: iid, citation_index: index, content_item_id: contentId,
    citation_ref: `${iid}:cite${index}`, quote: index === 1 ? quote : "unbound secondary synthetic quote", locator: "{}" });
  insert("display_coverage_audit", { batch_id: bid, insight_id: iid, candidate_id: iid, gate_version: mode === "legacygate" ? "display-coverage-v5" : "display-coverage-v6",
    terminal_reason: "kept", prompt_version: "synthetic", input_hash: "synthetic", validator_model: "synthetic-no-model-executed", created_at: now,
    decision: JSON.stringify({ statement_citation_index: 2, statement_citation_ref: `${iid}:cite1`, display_projection_version: "source_quote_v1",
      statement_sha256: mode === "audithash" ? "0".repeat(64) : hash(mode === "statementbad" ? `${quote} inflated` : quote), quote_sha256: hash(quote),
      claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [2], ...(mode === "nocounter" ? {} : { countercheck: { supports: true } }) }] }) });
  if (mode !== "unchecked") insert("citation_check", { batch_id: bid, insight_id: iid, citation_index: 1,
    reachability: mode === "reachfail" ? "fail" : "pass", reachability_reason: mode === "reachfail" ? "quote_not_in_source" : "ok",
    consistency: mode === "blocked" ? "not_support" : mode === "flagged" ? "uncertain" : "support",
    consistency_reason: mode === "blocked" ? "exaggeration" : mode === "flagged" ? "uncertain" : "ok",
    verdict: mode === "blocked" || mode === "reachfail" ? "blocked" : mode === "flagged" ? "flagged" : "pass" });
  insert("tech_lead", { id: leadId(mode), topic_id: topicId, canonical_key: `synthetic:${mode}`, kind: "other", title: "fixture-not-reader-authority",
    summary: "fixture-not-reader-authority", score: 80, score_detail: '{"total":80,"reason":"fixture-not-reader-authority"}', first_seen_at: now, last_seen_at: now, latest_evidence_at: now });
  insert("tech_lead_evidence", { lead_id: leadId(mode), insight_id: iid, citation_index: 1, added_at: now });
}
// Historical publication snapshots intentionally have no report-file effect. This is a documented legacy read exception,
// not a call to report-gen or saveReport, and never certifies current source availability.
for (const [n, id] of reportIds.entries()) {
  const title = `A2 historical snapshot ${n}`, path = `/data/reports/${id}`;
  const md = `# ${title}\n\nA2_SNAPSHOT_BODY_${n} [1]\n\n- [1] Atlas synthetic frozen matrix valid_old.\n`;
  writeFileSync(`${path}.md`, md); writeFileSync(`${path}.html`, `<h1>${title}</h1>`);
  insert("report", { id, type: "brief", topic_id: topicId, status: "done", generated_at: now, title, body_path: path,
    insight_ids: JSON.stringify([insightId("valid_old"), insightId("valid_long"), insightId("missing")]),
    prev_report_id: n === 1 ? reportIds[0] : null, citation_count: 3, cost: '{"tokens":0,"amount":0}' });
  insert("report_index", { report_id: id, type: "brief", topic_id: topicId, date: now, title, summary: `A2 historical ${n}`, importance: 3 });
  insert("report_fts", { report_id: id, title, summary: "A2 synthetic", body: md });
}
insert("report", { id: "rep_matrix_failed", type: "brief", topic_id: topicId, status: "failed", generated_at: now, title: "Failed synthetic", citation_count: 0, cost: "{}" });
// Negative FK paths on the complete migrated schema, independent from HTTP writer evidence.
assert.throws(() => insert("tech_lead_evidence", { lead_id: leadId("valid_old"), insight_id: "ins_nonexistent_link", citation_index: 1, added_at: now }), /FOREIGN KEY/);
assert.throws(() => insert("report", { id: "rep_bad_fk", type: "brief", topic_id: "topic_missing", status: "failed", generated_at: now, title: "bad", citation_count: 0, cost: "{}" }), /FOREIGN KEY/);
const state = snapshot(db);
const fixture = { schema_version: "a2-business-fixture-v1", origin: "direct-SQL-and-synthetic-files-not-business-writer", schema_migrations: state.ledger.length,
  schema_sha256: hash(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all())),
  ledger_sha256: hash(JSON.stringify(state.ledger)), database_sha256: hash(db.serialize()), raw_manifest_sha256: hash(JSON.stringify(rawManifest)), raw_manifest: rawManifest,
  report_hashes: reportIds.map(id => [id, hash(readFileSync(`/data/reports/${id}.md`))]), bundle: bundleIdentity(), initial: state };
writeFileSync("/data/matrix-fixture.json", JSON.stringify(fixture));
db.close();
console.log(JSON.stringify({ schema_version: fixture.schema_version, origin: fixture.origin, schema_migrations: 48, schema_sha256: fixture.schema_sha256, ledger_sha256: fixture.ledger_sha256,
  database_sha256: fixture.database_sha256, raw_manifest_sha256: fixture.raw_manifest_sha256, cases, report_hashes: fixture.report_hashes, bundle: fixture.bundle }));
