/** Reads only attested DELETE-journal archives. Never imports DB bootstrap/migration. */
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getContentItem, getTopic } from "../../src/lib/db/repos.js";
import { listRecentPublishedInsightOccurrences } from "../../src/lib/db/reports.js";
import { canonicalHash } from "../../src/lib/db/provenance-facts.js";
import type { PreparedData } from "../rich-brief-stage0/data.js";
import type { ReplayAttempt } from "./input.js";
import { fileResource, object, sha, utc, verifyResource, type Resource } from "./common.js";

export interface SnapshotConfig { run_id: string; db_path: string; backup_manifest: Resource; exporter_manifest: Resource }
export function attestSnapshot(config: SnapshotConfig): { db: Resource; manifest: Resource; as_of: string } {
  verifyResource(config.backup_manifest); verifyResource(config.exporter_manifest);
  const dbResource = fileResource(config.db_path), bytes = readFileSync(config.db_path);
  const originalPath = join(dirname(config.backup_manifest.path), "insight.db");
  for (const path of [config.db_path, originalPath]) {
    fileResource(path);
    if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${path}${suffix}`))) throw new Error("standalone_snapshot_required");
    const header = readFileSync(path).subarray(0, 20);
    if (header[18] !== 1 || header[19] !== 1) throw new Error("delete_journal_snapshot_required");
  }
  if (sha(readFileSync(originalPath)) !== dbResource.sha256) throw new Error("snapshot_not_exact_backup_bytes");
  const manifest = object(JSON.parse(readFileSync(config.backup_manifest.path, "utf8"))), exported = object(JSON.parse(readFileSync(config.exporter_manifest.path, "utf8")));
  const interval = object(manifest.db_snapshot_interval), time = object(exported.snapshot_time_evidence);
  if (manifest.schema_version !== 1 || !["complete", "incomplete"].includes(String(manifest.status)) || !Array.isArray(manifest.files)) throw new Error("backup_manifest_invalid");
  const entries = manifest.files.map(object).filter((r) => r.path === "insight.db");
  const from = utc.parse(interval.started_at), until = utc.parse(interval.completed_at), created = utc.parse(manifest.created_at);
  if (entries.length !== 1 || entries[0].sha256 !== dbResource.sha256 || entries[0].size !== bytes.length || interval.db_sha256 !== dbResource.sha256
    || from > until || until > created || !Number.isSafeInteger(interval.source_data_version_before) || Number(interval.source_data_version_before) < 0
    || interval.source_data_version_before !== interval.source_data_version_after || interval.source_data_version_unchanged !== true) throw new Error("backup_interval_or_db_binding_invalid");
  if (exported.format_version !== "brief-density-s0-v2" || exported.snapshot_sha256 !== dbResource.sha256 || exported.as_of !== until
    || time.status !== "db_interval_no_external_commit_observed" || time.backup_manifest_sha256 !== config.backup_manifest.sha256 || time.completed_at !== until) throw new Error("exporter_snapshot_binding_invalid");
  return { db: dbResource, manifest: config.backup_manifest, as_of: until };
}

export function recoverReplayAttempts(data: PreparedData, configs: SnapshotConfig[]): ReplayAttempt[] {
  if (new Set(configs.map((c) => c.run_id)).size !== configs.length) throw new Error("duplicate_snapshot_run");
  const replays: ReplayAttempt[] = [];
  for (const config of configs) {
    const evidence = attestSnapshot(config);
    if (!data.resources.some((r) => r.path === config.exporter_manifest.path && r.sha256 === config.exporter_manifest.sha256)) throw new Error("snapshot_export_not_bound_to_stage0_input");
    const registered = data.runs.find((r) => r.run_id === config.run_id);
    if (!registered || evidence.as_of < registered.scheduled_at || Date.parse(evidence.as_of) >= Date.parse(registered.scheduled_at) + 86400000) throw new Error("snapshot_outside_registered_run_interval");
    const db = new Database(config.db_path, { readonly: true, fileMustExist: true });
    try {
      if (db.prepare("SELECT 1 FROM provenance_redaction LIMIT 1").get() || db.prepare("SELECT 1 FROM provenance_redaction_request LIMIT 1").get()) throw new Error("redacted_snapshot_requires_review");
      const topic = getTopic(db, data.topic); if (!topic) throw new Error("snapshot_topic_missing");
      for (const attempt of data.attempts.filter((a) => a.run_id === config.run_id)) {
        const colon = attempt.attempt_id.lastIndexOf(":"), traceId = attempt.attempt_id.slice(0, colon), number = Number(attempt.attempt_id.slice(colon + 1));
        const start = db.prepare("SELECT input_refs FROM generation_event WHERE trace_id=? AND attempt=? AND stage='analyze' AND event_type='started'").get(traceId, number) as { input_refs: string } | undefined;
        const dispatch = db.prepare("SELECT id,payload FROM generation_dispatch WHERE trace_id=?").get(traceId) as { id: string; payload: string } | undefined;
        if (!start || !dispatch) throw new Error("original_start_or_dispatch_missing");
        const payload = object(JSON.parse(dispatch.payload)), end = utc.parse(payload.window_end);
        if (payload.topic_id !== data.topic || payload.report_type !== "brief" || payload.schema_version !== 1 || !Number.isFinite(payload.window_hours) || Number(payload.window_hours) <= 0) throw new Error("original_dispatch_window_missing");
        const startIso = new Date(Date.parse(end) - Number(payload.window_hours) * 3600000).toISOString();
        const occurrences = data.occurrences.filter((o) => o.attempt_id === attempt.attempt_id);
        const refs = (JSON.parse(start.input_refs) as unknown[]).map(object).filter((r) => r.type === "content_item");
        if (refs.length !== occurrences.length) throw new Error("original_start_input_count_mismatch");
        const items = occurrences.map((occurrence) => {
          if (occurrence.ref.locator.kind !== "id") throw new Error("source_id_ref_required");
          const item = getContentItem(db, occurrence.ref.locator.id);
          if (!item || item.body !== occurrence.body || sha(item.body) !== occurrence.body_sha256 || item.body_kind !== occurrence.body_kind) throw new Error("archived_content_revision_mismatch");
          const snapshot = { body_kind: item.body_kind, body_length: item.body.length, content_hash: item.content_hash, fetch_status: item.fetch_status, fetched_at: item.fetched_at,
            published_at: item.published_at, source_id: item.source_id, title: item.title, url: item.url };
          if (`content-v4:${canonicalHash(snapshot)}` !== occurrence.ref.revision || !refs.some((r) => object(r.locator).id === item.id && r.revision === occurrence.ref.revision)) throw new Error("exact_content_v4_binding_mismatch");
          return item;
        });
        const observed = listRecentPublishedInsightOccurrences(db, data.topic, { asOf: end });
        const history: ReplayAttempt["history"] = { status: "cutoff_safe_lower_bound", events: [], excluded_after_cutoff: 0, unproven_publication_occurrences: 0,
          reason: "Snapshot query uses the actual production history function, then proves publication before dispatch endIso. Earlier reader/source state and exact original model-visible history are not persisted; this is a lower bound, never an empty complete history." };
        for (const old of observed) {
          const report = db.prepare("SELECT generated_at FROM report WHERE id=?").get(old.report_id) as { generated_at: string };
          if (!Number.isFinite(Date.parse(report.generated_at)) || Date.parse(report.generated_at) > Date.parse(end)) { history.excluded_after_cutoff++; continue; }
          const effects = db.prepare("SELECT status,updated_at FROM generation_effect WHERE report_id=? AND kind='report_file'").all(old.report_id) as { status: string; updated_at: string }[];
          if (effects.length !== 1 || effects[0].status !== "committed" || !Number.isFinite(Date.parse(effects[0].updated_at)) || Date.parse(effects[0].updated_at) > Date.parse(end)) { history.unproven_publication_occurrences++; continue; }
          history.events.push({ event_id: old.event_id, statement: old.statement, statement_fingerprint: old.statement_fingerprint, content_item_ids: old.content_item_ids, type: old.insight_type, date: old.date });
        }
        replays.push({ attempt_id: attempt.attempt_id, topic, items, time_window: { start: startIso, end }, history,
          snapshot_resources: [evidence.db, config.backup_manifest, config.exporter_manifest] });
      }
    } finally { db.close(); }
    if (fileResource(config.db_path).sha256 !== evidence.db.sha256) throw new Error("snapshot_changed_during_read");
    verifyResource(config.backup_manifest); verifyResource(config.exporter_manifest);
  }
  return replays;
}
