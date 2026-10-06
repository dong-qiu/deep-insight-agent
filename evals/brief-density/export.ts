/** Private, read-only S0 diagnostics. Never opens the application's bootstrap DB. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { canonicalHash, entityKey, type EntityRef } from "../../src/lib/db/provenance-facts.js";
import { contentHash, normalizeBody, MAX_BODY_CHARS, MAX_TRANSCRIPT_CHARS } from "../../src/lib/sources/normalize.js";

type Row = Record<string, unknown>;
type Ref = EntityRef;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const rows = (db: Database.Database, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
const obj = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
function parsed(value: unknown): unknown { try { return JSON.parse(String(value)); } catch { return null; } }
function refs(event: Row, field: string): Ref[] {
  const value = parsed(event[field]);
  return Array.isArray(value) ? value.filter((v) => obj(v) && obj(v.locator) && typeof v.type === "string" && typeof v.revision === "string") : [];
}
const idOf = (ref: Ref) => ref.locator.kind === "id" ? ref.locator.id : null;
export interface ExportOptions {
  dbPath: string; outputDir: string; from: string; until: string; topics: string[];
  asOf: string; gitSha: string; dataDir?: string; backupManifestPath?: string;
}
function requirePrivateOutput(outputDir: string): void {
  if (existsSync(outputDir)) throw new Error("output_dir_exists");
  const parent = realpathSync(dirname(outputDir));
  const target = join(parent, basename(outputDir));
  let cursor = parent;
  while (!existsSync(join(cursor, ".git"))) {
    const next = dirname(cursor);
    if (next === cursor) return; // Confirmed outside any Git worktree.
    cursor = next;
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const ignored = spawnSync("git", ["-C", parent, "check-ignore", "-q", "--no-index", "--", target], { encoding: "utf8", env });
  if (ignored.error) throw ignored.error;
  if (ignored.status !== 0) throw new Error("output_dir_must_be_gitignored");
}
function validateOptions(o: ExportOptions): void {
  for (const p of [o.dbPath, o.outputDir, ...(o.dataDir ? [o.dataDir] : []), ...(o.backupManifestPath ? [o.backupManifestPath] : [])]) if (!isAbsolute(p)) throw new Error("absolute_paths_required");
  for (const d of [o.from, o.until, o.asOf]) if (!Number.isFinite(Date.parse(d)) || new Date(d).toISOString() !== d) throw new Error("canonical_utc_required");
  if (o.from >= o.until || o.asOf < o.until || !o.topics.length || new Set(o.topics).size !== o.topics.length) throw new Error("invalid_cohort");
  if (!/^[a-f0-9]{40}$/.test(o.gitSha)) throw new Error("git_sha_required");
  requirePrivateOutput(o.outputDir);
  if (existsSync(`${o.dbPath}-wal`) || existsSync(`${o.dbPath}-shm`)) throw new Error("standalone_offline_snapshot_required");
  const header = readFileSync(o.dbPath).subarray(0, 20);
  if (header[18] !== 1 || header[19] !== 1) throw new Error("delete_journal_snapshot_required");
  if (lstatSync(o.dbPath).isSymbolicLink()) throw new Error("snapshot_symlink_forbidden");
}

function snapshotTimeEvidence(o: ExportOptions, dbSha256: string, dbBytes: number): Row {
  if (!o.backupManifestPath) return { status: "operator_as_of_unattested" };
  const path = o.backupManifestPath;
  if (lstatSync(path).isSymbolicLink()) throw new Error("backup_manifest_symlink_forbidden");
  const manifestBytes = readFileSync(path);
  const manifest = obj(parsed(manifestBytes.toString("utf8")));
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files)
    || typeof manifest.status !== "string" || !["complete", "incomplete"].includes(manifest.status)) throw new Error("backup_manifest_invalid");
  const files = manifest.files.map(obj);
  const dbEntries = files.filter((file) => file?.path === "insight.db");
  const dbEntry = dbEntries.length === 1 ? dbEntries[0] : null;
  const interval = obj(manifest.db_snapshot_interval);
  const utc = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  const before = interval?.source_data_version_before;
  const after = interval?.source_data_version_after;
  if (!dbEntry || dbEntry.sha256 !== dbSha256 || dbEntry.size !== dbBytes
    || !interval || !utc(interval.started_at) || !utc(interval.completed_at) || !utc(manifest.created_at)
    || interval.started_at > interval.completed_at || interval.completed_at > manifest.created_at
    || !Number.isSafeInteger(before) || Number(before) < 0 || !Number.isSafeInteger(after) || Number(after) < 0
    || interval.source_data_version_unchanged !== (before === after) || interval.db_sha256 !== dbSha256) {
    throw new Error("backup_interval_or_db_binding_invalid");
  }
  const sourceDbPath = join(dirname(path), "insight.db");
  if (lstatSync(sourceDbPath).isSymbolicLink()) throw new Error("backup_db_symlink_forbidden");
  const sourceDb = readFileSync(sourceDbPath);
  if (sourceDb.length !== dbBytes || sha(sourceDb) !== dbSha256) throw new Error("backup_source_db_mismatch");
  if (interval.source_data_version_unchanged !== true) throw new Error("backup_interval_external_commit_observed");
  if (o.asOf !== interval.completed_at) throw new Error("as_of_must_equal_stable_interval_end");
  return { status: "db_interval_no_external_commit_observed", backup_manifest_sha256: sha(manifestBytes),
    backup_db_sha256: dbSha256, started_at: interval.started_at, completed_at: interval.completed_at,
    source_data_version_before: before, source_data_version_after: after,
    declared_backup_status: manifest.status, verification_scope: "db_and_interval_only" };
}

function sourceEvidence(db: Database.Database, ref: Ref, dataDir?: string): Row {
  const id = idOf(ref);
  if (!id || ref.type !== "content_item") return { ref, gaps: ["invalid_content_ref"] };
  const gaps: string[] = [];
  const revision = rows(db, "SELECT * FROM provenance_revision WHERE entity_type='content_item' AND entity_key=? AND revision=?", entityKey(ref), ref.revision)[0];
  const snapshot = obj(parsed(revision?.snapshot));
  const revisionValid = Boolean(snapshot && ref.revision === `content-v4:${canonicalHash(snapshot)}` && revision?.snapshot_hash === canonicalHash(snapshot));
  if (!revisionValid) gaps.push("revision_missing_or_invalid");
  const source = rows(db, "SELECT id,source_id,url,title,published_at,fetched_at,body,body_kind,fetch_status,content_hash,raw_ref,reader_eligible FROM content_item WHERE id=?", id)[0];
  let body: string | null = null;
  if (!source) gaps.push("source_row_missing");
  else if (typeof source.body !== "string" || !revisionValid || !snapshot || source.content_hash !== snapshot.content_hash
    || contentHash(source.body) !== snapshot.content_hash || source.body.length !== snapshot.body_length) gaps.push("source_version_mismatch");
  else body = source.body;
  if (source?.reader_eligible !== 1) gaps.push("source_not_reader_eligible");
  const effects = rows(db, "SELECT id,status,artifact_manifest,idempotency_key FROM generation_effect WHERE kind='raw_archive' AND raw_content_id=? ORDER BY id", id);
  const matching = effects.filter((e) => {
    const manifest = parsed(e.artifact_manifest);
    return Array.isArray(manifest) && manifest.some((a) => obj(a) && `raw/${a.target}` === source?.raw_ref);
  });
  let archive: Row | null = null;
  if (matching.length !== 1 || matching[0].status !== "committed") gaps.push("archive_binding_missing");
  else {
    const manifest = parsed(matching[0].artifact_manifest) as Row[];
    const artifact = manifest.length === 1 ? manifest[0] : null;
    archive = { effect: matching[0], file_integrity_verified: false, content_version_verified: false };
    if (!artifact || typeof artifact.target !== "string" || !/^[A-Za-z0-9_-]{1,128}\.[a-f0-9]{64}\.txt$/.test(artifact.target)
      || artifact.target !== `${id}.${artifact.sha256}.txt` || matching[0].idempotency_key !== `raw_archive:${id}:${artifact.sha256}`) gaps.push("archive_manifest_invalid");
    else if (!dataDir || !existsSync(join(dataDir, "raw", artifact.target))) gaps.push("archive_file_missing");
    else {
      const root = realpathSync(join(dataDir, "raw"));
      const path = join(root, artifact.target);
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) gaps.push("archive_path_invalid");
      else {
        const bytes = readFileSync(path);
        if (bytes.length !== artifact.size || sha(bytes) !== artifact.sha256) gaps.push("archive_hash_mismatch");
        else {
          archive.file_integrity_verified = true;
          const envelope = obj(parsed(bytes.toString("utf8")));
          if (!envelope || envelope.schema_version !== "content-raw-archive-v1" || typeof envelope.source_body !== "string") gaps.push("archive_envelope_unavailable");
          else if (envelope.structured_body_sha256 !== snapshot?.content_hash || envelope.source_body_kind !== snapshot?.body_kind
            || !["article", "show_notes", "transcript"].includes(String(envelope.source_body_kind))
            || body === null || normalizeBody(envelope.source_body).slice(0, envelope.source_body_kind === "transcript" ? MAX_TRANSCRIPT_CHARS : MAX_BODY_CHARS) !== body) gaps.push("archive_content_version_mismatch");
          else archive.content_version_verified = true;
        }
      }
    }
  }
  return { ref, revision: revision ?? null, snapshot, body, body_sha256: body === null ? null : sha(body), archive, gaps };
}

/** Historical loss labels describe stored observations, never a new publishability decision. */
export function terminalBucket(audit: Row | null, insight: Row | null, checks: Row[], decisions: Row[], published: boolean): string {
  if (published) return "published";
  if (!insight) return audit && String(audit.terminal_reason).startsWith("dropped_") ? "display_audit_rejected" : "unknown";
  if (new Set(decisions.map((d) => d.reason_code)).size > 1) return "multiple_attempt_outcomes";
  if (checks.length && checks.every((c) => c.verdict === "blocked" || c.consistency === "not_support")) return "validator_rejected";
  const reasons = new Set(decisions.map((d) => d.reason_code));
  if ([...reasons].some((r) => ["already_published_event", "already_published_fingerprint", "supplemental_ineligible", "supplemental_missing_event"].includes(String(r)))) return "history_or_freshness_filtered";
  if ([...reasons].some((r) => ["batch_duplicate", "reader_visible_duplicate", "supplemental_duplicate_event"].includes(String(r)))) return "representative_collapsed";
  if (reasons.has("supplemental_limit") || reasons.has("selection_rule_excluded")) return "selection_budget_filtered";
  if (reasons.has("projection_or_citation_gate")) return "projection_or_citation_gate";
  return "unknown";
}
function quoteEvidence(citation: Row, sources: Row[]): Row {
  const matches = sources.filter((s) => idOf(s.ref as Ref) === citation.content_item_id);
  if (matches.length !== 1 || typeof matches[0].body !== "string") return { ...citation, locator_verified: false, evidence_gap: "source_binding_unavailable" };
  const locator = obj(parsed(citation.locator));
  const body = matches[0].body;
  const start = locator?.char_start, end = locator?.char_end;
  const verified = Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 0 && Number(end) > Number(start)
    && Number(end) <= body.length && body.slice(Number(start), Number(end)) === citation.quote;
  return { ...citation, locator_verified: verified, evidence_gap: verified ? null : "quote_locator_mismatch" };
}

export function exportBriefDensity(o: ExportOptions): { batches: number; candidates: number; tracesWithoutBatch: number } {
  validateOptions(o);
  const hashBefore = sha(readFileSync(o.dbPath));
  const timeEvidence = snapshotTimeEvidence(o, hashBefore, lstatSync(o.dbPath).size);
  const db = new Database(o.dbPath, { readonly: true, fileMustExist: true });
  let result: { pool: Row[]; manifest: Row; loss: Row };
  try {
    result = db.transaction(() => {
      // Do not restore a backup as a running application or bypass its tombstones.
      if (rows(db, "SELECT record_id FROM provenance_redaction LIMIT 1").length
        || rows(db, "SELECT deletion_request_id FROM provenance_redaction_request LIMIT 1").length) throw new Error("redacted_snapshot_requires_scoped_export_review");
      const placeholders = o.topics.map(() => "?").join(",");
      if (rows(db, `SELECT id FROM topic WHERE id IN (${placeholders})`, ...o.topics).length !== o.topics.length) throw new Error("unknown_topic");
      const batches = rows(db, `SELECT * FROM analysis_batch WHERE topic_id IN (${placeholders}) AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?) ORDER BY created_at,id`, ...o.topics, o.from, o.until);
      const events = rows(db, `SELECT e.*,t.topic_id AS cohort_topic_id FROM generation_event e JOIN generation_trace t ON t.id=e.trace_id WHERE t.topic_id IN (${placeholders}) AND julianday(e.occurred_at)>=julianday(?) AND julianday(e.occurred_at)<julianday(?) ORDER BY e.trace_id,e.sequence`, ...o.topics, o.from, o.until);
      const pool: Row[] = [], counts: Record<string, Record<string, number>> = Object.fromEntries(o.topics.map((t) => [t, {}]));
      const gaps: Record<string, number> = {};
      const gapsByKind: Record<string, Record<string, number>> = { batch: {}, trace_without_batch: {} };
      function countGaps(sources: Row[], kind: string): void {
        for (const source of sources) for (const gap of source.gaps as string[]) {
          gaps[gap] = (gaps[gap] ?? 0) + 1;
          gapsByKind[kind][gap] = (gapsByKind[kind][gap] ?? 0) + 1;
        }
      }
      function diagnostics(event: Row): Row[] {
        return refs(event, "output_refs").filter((r) => r.type === "analysis_coverage_diagnostics").map((ref) => {
          const row = rows(db, "SELECT * FROM provenance_revision WHERE entity_type=? AND entity_key=? AND revision=?", ref.type, entityKey(ref), ref.revision)[0];
          const snapshot = obj(parsed(row?.snapshot));
          const verified = Boolean(snapshot && canonicalHash(snapshot) === ref.revision && row.snapshot_hash === ref.revision && Array.isArray(snapshot.candidates));
          return { ref, revision: row ?? null, verified, observed_candidates: verified ? snapshot!.candidates : null };
        });
      }
      let candidateTotal = 0;
      for (const batch of batches) {
        const batchId = String(batch.id), topic = String(batch.topic_id);
        const completions = rows(db, `SELECT e.* FROM generation_event e JOIN generation_entity_ref r ON r.event_id=e.id WHERE r.entity_type='analysis_batch' AND r.entity_key=? AND r.role='output' AND e.stage='analyze' AND e.event_type='completed' ORDER BY e.occurred_at,e.id`, entityKey({ type: "analysis_batch", locator: { kind: "id", id: batchId } })).filter((e) => Date.parse(String(e.occurred_at)) <= Date.parse(o.asOf));
        const links = completions.map((event) => ({ completed: event, started: rows(db, "SELECT * FROM generation_event WHERE trace_id=? AND stage='analyze' AND event_type='started' AND attempt=?", String(event.trace_id), Number(event.attempt))[0] ?? null }));
        // Multiple runs/cache reuses remain separate evidence chains. Never silently choose one.
        const sourceRefs = new Map<string, Ref>();
        for (const link of links) if (link.started) for (const ref of refs(link.started, "input_refs")) if (ref.type === "content_item") sourceRefs.set(`${idOf(ref)}:${ref.revision}`, ref);
        const sources = [...sourceRefs.values()].map((ref) => sourceEvidence(db, ref, o.dataDir));
        countGaps(sources, "batch");
        const insights = rows(db, "SELECT * FROM insight WHERE batch_id=? ORDER BY id", batchId);
        const audits = rows(db, "SELECT * FROM display_coverage_candidate_audit WHERE batch_id=? ORDER BY candidate_id", batchId);
        const reviews = rows(db, "SELECT s.*,r.status,r.insight_ids,r.type,r.generated_at FROM report_review_snapshot s JOIN report r ON r.id=s.report_id WHERE s.analysis_batch_id=? ORDER BY r.generated_at,r.id", batchId).filter((r) => r.type === "brief" && Date.parse(String(r.generated_at)) <= Date.parse(o.asOf));
        const decisions = reviews.flatMap((r) => rows(db, "SELECT * FROM report_selection_decision WHERE report_id=? ORDER BY insight_id", String(r.report_id)));
        const publishedIds = new Set(reviews.filter((r) => r.type === "brief" && r.status === "done" && r.publication_state === "published").flatMap((r) => {
          const ids = parsed(r.insight_ids); return Array.isArray(ids) ? ids : [];
        }));
        const candidateAudits: (Row | null)[] = [...audits, ...insights.filter((i) => !audits.some((a) => a.insight_id === i.id)).map(() => null)];
        const unmatched = insights.filter((i) => !audits.some((a) => a.insight_id === i.id));
        const candidates = candidateAudits.map((audit) => {
          const insight = audit ? insights.find((i) => i.id === audit.insight_id) ?? null : unmatched.shift()!;
          const checks = insight ? rows(db, "SELECT * FROM citation_check WHERE batch_id=? AND insight_id=? ORDER BY citation_index", batchId, String(insight.id)) : [];
          const citations = insight ? rows(db, "SELECT * FROM citation WHERE insight_id=? ORDER BY citation_index", String(insight.id)).map((c) => quoteEvidence(c, sources)) : [];
          const keptAudit = insight ? rows(db, "SELECT * FROM display_coverage_audit WHERE batch_id=? AND insight_id=?", batchId, String(insight.id))[0] ?? null : null;
          const selection = insight ? decisions.filter((d) => d.insight_id === insight.id) : [];
          const auditDecision = obj(parsed(audit?.decision));
          const auditClaims = Array.isArray(auditDecision?.claims) ? auditDecision.claims.filter((claim) => obj(claim) && typeof claim.text === "string") : [];
          const auditTextAvailable = auditClaims.length > 0 || typeof auditDecision?.statement_citation_claim === "string";
          const terminal = terminalBucket(audit, insight, checks, selection, publishedIds.has(insight?.id));
          const reportOutcomes = reviews.map((r) => ({ report_id: r.report_id, status: r.status, generated_at: r.generated_at,
            terminal: terminalBucket(audit, insight, checks, selection.filter((d) => d.report_id === r.report_id),
              r.status === "done" && r.publication_state === "published" && Array.isArray(parsed(r.insight_ids)) && (parsed(r.insight_ids) as unknown[]).includes(insight?.id)) }));
          counts[topic][terminal] = (counts[topic][terminal] ?? 0) + 1;
          candidateTotal++;
          return { audit, insight, kept_audit: keptAudit, checks, citations, selection, terminal, report_outcomes: reportOutcomes,
            candidate_text_status: insight ? "retained_text_available" : auditTextAvailable ? "audit_claim_text_available" : "not_persisted",
            audit_claims: auditClaims, // Rejected drafts are diagnostic text, never approved report members.
            experiment_eligibility: "not_evaluated", // S0 does not approve evidence for publication.
          };
        });
        pool.push({ kind: "batch", batch, analysis_links: links, input_evidence: sources, candidates, report_reviews: reviews, analysis_diagnostics: completions.flatMap(diagnostics),
          validation: rows(db, "SELECT * FROM validation_result WHERE batch_id=?", batchId)[0] ?? null,
          observability: { input_chain: links.length && sources.length ? "recorded" : "unknown", extraction_omissions: "requires_source_labels", event_complementarity: "requires_human_labels" } });
      }
      const batchIds = new Set(batches.map((b) => b.id));
      const starts = events.filter((e) => e.stage === "analyze" && e.event_type === "started");
      for (const start of starts) {
        const terminals = rows(db, "SELECT * FROM generation_event WHERE trace_id=? AND attempt=? AND stage='analyze' AND event_type<>'started' AND julianday(occurred_at)<=julianday(?) ORDER BY sequence", String(start.trace_id), Number(start.attempt), o.asOf);
        const completed = terminals.find((e) => e.event_type === "completed");
        if (completed && refs(completed, "output_refs").some((r) => r.type === "analysis_batch" && batchIds.has(idOf(r)))) continue;
        const diagnosticRows = terminals.flatMap(diagnostics);
        const observed = diagnosticRows.flatMap((d) => Array.isArray(d.observed_candidates) ? d.observed_candidates as Row[] : []);
        const sources = refs(start, "input_refs").filter((r) => r.type === "content_item").map((r) => sourceEvidence(db, r, o.dataDir));
        countGaps(sources, "trace_without_batch");
        pool.push({ kind: "trace_without_batch", topic_id: start.cohort_topic_id, started: start, terminal_events: terminals, analysis_diagnostics: diagnosticRows,
          input_evidence: sources, candidates: observed.length ? observed : null, observed_candidate_count: observed.length, diagnostic_integrity: diagnosticRows.length ? (diagnosticRows.every((d) => d.verified) ? "verified" : "gap") : "unavailable",
          total_candidate_count: "unknown", candidate_text_status: "not_persisted", terminal: "analysis_attempt_without_in_window_batch" });
      }
      const countsResult = { batches: batches.length, candidates: candidateTotal, tracesWithoutBatch: pool.filter((p) => p.kind === "trace_without_batch").length };
      return { pool, loss: { ...countsResult, by_topic: counts, input_evidence_gaps: gaps, input_evidence_gaps_by_kind: gapsByKind, gap_denominator: "input_revision_occurrences_per_export_record", terminal_aggregation: "ever_published_brief_by_as_of_else_unambiguous_observed_reason", observed_candidates_without_batch: pool.filter((p) => p.kind === "trace_without_batch").reduce((n, p) => n + Number(p.observed_candidate_count), 0), missing_extracted_facts: "requires_source_labels", qualified_complementary_events: "pending_human_labels_and_eligibility_replay" }, manifest: {
        format_version: "brief-density-s0-v2", as_of: o.asOf, snapshot_time_evidence: timeEvidence, window: { from_inclusive: o.from, until_exclusive: o.until }, topics: o.topics, git_sha: o.gitSha,
        exporter_sha256: sha(readFileSync(new URL(import.meta.url))), snapshot_sha256: hashBefore, snapshot_bytes: lstatSync(o.dbPath).size,
        schema: rows(db, "SELECT * FROM schema_migration ORDER BY version"),
        deployment: rows(db, "SELECT git_sha,image_digest,deployed_at FROM deployment_record ORDER BY deployed_at DESC LIMIT 1"),
        ...countsResult, cohort: "all_analysis_batches_in_window_plus_observed_analyze_attempts_without_batch", reader_status: "private_diagnostic_only", human_labels: "pending",
      } };
    })();
  } finally { db.close(); }
  if (sha(readFileSync(o.dbPath)) !== hashBefore) throw new Error("snapshot_changed_during_export");
  if (o.backupManifestPath && (sha(readFileSync(o.backupManifestPath)) !== timeEvidence.backup_manifest_sha256
    || sha(readFileSync(join(dirname(o.backupManifestPath), "insight.db"))) !== hashBefore)) throw new Error("backup_evidence_changed_during_export");
  // Refuse reuse, even if a previous export stopped partway. A manifest marks completion.
  mkdirSync(o.outputDir, { mode: 0o700 });
  const write = (name: string, text: string) => writeFileSync(join(o.outputDir, name), text, { flag: "wx", mode: 0o600 });
  const poolText = result.pool.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const lossText = JSON.stringify(result.loss, null, 2) + "\n";
  write("candidate-pool.jsonl", poolText);
  write("stage-loss.json", lossText);
  write("snapshot-manifest.json", JSON.stringify({ ...result.manifest, artifact_hashes: { "candidate-pool.jsonl": sha(poolText), "stage-loss.json": sha(lossText) } }, null, 2) + "\n");
  return { batches: Number(result.manifest.batches), candidates: Number(result.manifest.candidates), tracesWithoutBatch: Number(result.manifest.tracesWithoutBatch) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [outputDir, from, until, topics, asOf, gitSha] = process.argv.slice(2);
  if (!outputDir || !from || !until || !topics || !asOf || !gitSha || !process.env.DB_PATH) throw new Error("Usage: DB_PATH=/abs/offline.db tsx evals/brief-density/export.ts /abs/new-output from-utc until-utc topic1,topic2 as-of-utc git-sha (optional BRIEF_DENSITY_DATA_DIR=/abs/archive-copy BRIEF_DENSITY_BACKUP_MANIFEST=/abs/backup-manifest.json)");
  console.log(JSON.stringify(exportBriefDensity({ dbPath: process.env.DB_PATH, outputDir, from, until, topics: topics.split(","), asOf, gitSha, dataDir: process.env.BRIEF_DENSITY_DATA_DIR, backupManifestPath: process.env.BRIEF_DENSITY_BACKUP_MANIFEST })));
}
