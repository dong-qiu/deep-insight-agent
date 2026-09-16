/** Bounded report-quality review package.  This module only binds existing
 * provenance rows; it never copies source bodies, raw fetch handles or prompts. */
import type { DB } from "./index.js";
import { canonicalHash, entityKey, type EntityRef } from "./provenance-facts.js";

export const REPORT_SELECTION_RULE_VERSION = "report-selection-v1";
export type ReviewDecision = {
  insight_id: string; decision: "published" | "excluded"; reason_code: string;
  related_insight_id?: string | null; published_rank?: number | null;
  supporting_citation_indices: number[];
};
export type ReviewPackage = {
  report_id: string; trace_id: string; analysis_batch_id: string;
  analyze_started_event_id: string; analyze_completed_event_id: string;
  validate_started_event_id: string;
  validate_completed_event_id: string; generate_report_started_event_id: string;
  selection_rule_version: string; decisions: ReviewDecision[];
};
export type ReviewPackageEffectBinding = { traceId: string; eventId: string };

/** These errors describe immutable review-package integrity failures, not a transient anchor I/O failure. */
const TERMINAL_REVIEW_PACKAGE_ERRORS = new Set([
  "report_review_event_missing",
  "report_review_event_refs_invalid",
  "report_review_event_trace_mismatch",
  "report_review_package_missing_or_not_planned",
  "report_review_trace_binding_invalid",
  "report_review_effect_binding_mismatch",
  "report_review_decisions_not_complete",
  "report_review_published_set_mismatch",
  "report_review_citation_indices_invalid",
  "report_review_citation_not_publishable",
  "report_review_package_publish_failed",
]);
export function isTerminalReviewPackageError(message: string): boolean {
  return TERMINAL_REVIEW_PACKAGE_ERRORS.has(message);
}

function eventMatches(db: DB, id: string, traceId: string, stage: string, type: string): boolean {
  return !!db.prepare("SELECT 1 FROM generation_event WHERE id=? AND trace_id=? AND stage=? AND event_type=?")
    .get(id, traceId, stage, type);
}

type StoredRef = { type: string; locator: { kind: string; id?: string; key?: { batch_id?: string } }; revision: string; role?: EntityRef["role"] };
function refsFor(db: DB, id: string): { input: StoredRef[]; output: StoredRef[] } {
  const row = db.prepare("SELECT input_refs,output_refs FROM generation_event WHERE id=?").get(id) as { input_refs: string; output_refs: string } | undefined;
  if (!row) throw new Error("report_review_event_missing");
  try { return { input: JSON.parse(row.input_refs), output: JSON.parse(row.output_refs) }; } catch { throw new Error("report_review_event_refs_invalid"); }
}
function hasBatchRef(refs: StoredRef[], batchId: string): boolean {
  return refs.some((ref) => ref.type === "analysis_batch" && ref.locator?.kind === "id" && ref.locator.id === batchId && ref.revision === batchId);
}
function hasValidationRef(refs: StoredRef[], batchId: string): boolean {
  return refs.some((ref) => ref.type === "validation_result" && ref.locator?.kind === "composite" && ref.locator.key?.batch_id === batchId && ref.revision === batchId);
}
function sameRefs(left: StoredRef[], right: StoredRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => {
    const other = right[index];
    return !!other && ref.type === other.type && ref.revision === other.revision && ref.role === other.role
      && JSON.stringify(ref.locator) === JSON.stringify(other.locator);
  });
}
function isV4ContentSnapshot(db: DB, ref: StoredRef): boolean {
  if (ref.type !== "content_item" || ref.role !== "input" || ref.locator?.kind !== "id" || !ref.locator.id
    || !/^content-v4:[a-f0-9]{64}$/.test(ref.revision)) return false;
  const entityRef: EntityRef = { type: "content_item", locator: { kind: "id", id: ref.locator.id }, revision: ref.revision, role: "input" };
  const row = db.prepare("SELECT snapshot FROM provenance_revision WHERE entity_type=? AND entity_key=? AND revision=?")
    .get(ref.type, entityKey(entityRef), ref.revision) as { snapshot: string } | undefined;
  if (!row) return false;
  try {
    const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>;
    const expectedKeys = ["body_kind", "body_length", "content_hash", "fetch_status", "fetched_at", "published_at", "source_id", "title", "url"];
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || Object.keys(snapshot).sort().join("\0") !== expectedKeys.join("\0")
      || typeof snapshot.url !== "string" || typeof snapshot.source_id !== "string" || typeof snapshot.title !== "string"
      || !(typeof snapshot.published_at === "string" || snapshot.published_at === null)
      || !(typeof snapshot.fetched_at === "string" || snapshot.fetched_at === null)
      || typeof snapshot.body_kind !== "string" || typeof snapshot.fetch_status !== "string"
      || !Number.isSafeInteger(snapshot.body_length) || (snapshot.body_length as number) < 0
      || typeof snapshot.content_hash !== "string") return false;
    return ref.revision === `content-v4:${canonicalHash(snapshot)}`;
  } catch { return false; }
}
type EventMeta = { sequence: number; attempt: number; version_context: string; context_completeness: string };
function eventMeta(db: DB, id: string): EventMeta {
  const row = db.prepare("SELECT sequence,attempt,version_context,context_completeness FROM generation_event WHERE id=?").get(id) as EventMeta | undefined;
  if (!row) throw new Error("report_review_event_missing");
  return row;
}
function hasCompleteContext(event: EventMeta, keys: readonly string[]): boolean {
  if (event.context_completeness !== "complete") return false;
  try {
    const context = JSON.parse(event.version_context) as Record<string, unknown>;
    return !!context && typeof context === "object" && !Array.isArray(context) && keys.every((key) => typeof context[key] === "string");
  } catch { return false; }
}

/** Called in the same intent transaction as report+generation_effect creation. */
export function persistReportReviewPackage(db: DB, pkg: ReviewPackage): void {
  if (!eventMatches(db, pkg.analyze_started_event_id, pkg.trace_id, "analyze", "started")
    || !eventMatches(db, pkg.analyze_completed_event_id, pkg.trace_id, "analyze", "completed")
    || !eventMatches(db, pkg.validate_started_event_id, pkg.trace_id, "validate", "started")
    || !eventMatches(db, pkg.validate_completed_event_id, pkg.trace_id, "validate", "completed")
    || !eventMatches(db, pkg.generate_report_started_event_id, pkg.trace_id, "generate_report", "started")) {
    throw new Error("report_review_event_trace_mismatch");
  }
  const analyzeStarted = refsFor(db, pkg.analyze_started_event_id);
  const analyzeCompleted = refsFor(db, pkg.analyze_completed_event_id);
  const validateStarted = refsFor(db, pkg.validate_started_event_id);
  const validateCompleted = refsFor(db, pkg.validate_completed_event_id);
  const reportStarted = refsFor(db, pkg.generate_report_started_event_id);
  const analyzeStartEvent = eventMeta(db, pkg.analyze_started_event_id);
  const analyzeCompleteEvent = eventMeta(db, pkg.analyze_completed_event_id);
  const validateStartEvent = eventMeta(db, pkg.validate_started_event_id);
  const validateCompleteEvent = eventMeta(db, pkg.validate_completed_event_id);
  const reportStartEvent = eventMeta(db, pkg.generate_report_started_event_id);
  if (analyzeStartEvent.attempt !== analyzeCompleteEvent.attempt || validateStartEvent.attempt !== validateCompleteEvent.attempt
    || !(analyzeStartEvent.sequence < analyzeCompleteEvent.sequence && analyzeCompleteEvent.sequence < validateStartEvent.sequence && validateStartEvent.sequence < validateCompleteEvent.sequence && validateCompleteEvent.sequence < reportStartEvent.sequence)
    || !hasBatchRef(analyzeCompleted.output, pkg.analysis_batch_id)
    || !hasBatchRef(validateStarted.input, pkg.analysis_batch_id)
    || !hasBatchRef(validateCompleted.input, pkg.analysis_batch_id)
    || !hasValidationRef(validateCompleted.output, pkg.analysis_batch_id)
    || !hasBatchRef(reportStarted.input, pkg.analysis_batch_id)
    || !hasValidationRef(reportStarted.input, pkg.analysis_batch_id)
    || !analyzeStarted.input.length
    || !sameRefs(analyzeStarted.input, analyzeCompleted.input)
    || !sameRefs(analyzeStarted.input, validateStarted.input.filter((ref) => ref.type === "content_item"))
    || !sameRefs(analyzeStarted.input, validateCompleted.input.filter((ref) => ref.type === "content_item"))
    || analyzeStarted.input.some((ref) => !isV4ContentSnapshot(db, ref))
    || !hasCompleteContext(analyzeStartEvent, ["analyzer_model", "analyzer_prompt_hash", "analyzer_output_version", "analyzer_cache_mode", "coverage_model", "coverage_prompt_hash", "coverage_thinking", "coverage_thinking_source"])
    || !hasCompleteContext(validateStartEvent, ["validator_model", "validator_prompt_hash", "validator_thinking", "validator_cache_mode"])
    || !hasCompleteContext(validateCompleteEvent, ["validator_model", "validator_prompt_hash", "validator_thinking", "validator_cache_mode"])
    || validateStartEvent.version_context !== validateCompleteEvent.version_context
    || !hasCompleteContext(reportStartEvent, ["report_selection_rule", "report_renderer"])) {
    throw new Error("report_review_trace_binding_invalid");
  }
  const actualInsightIds = new Set((db.prepare("SELECT id FROM insight WHERE batch_id=?").all(pkg.analysis_batch_id) as { id: string }[]).map((x) => x.id));
  if (actualInsightIds.size !== pkg.decisions.length || pkg.decisions.some((x) => !actualInsightIds.delete(x.insight_id))) {
    throw new Error("report_review_decisions_not_complete");
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO report_review_snapshot
    (report_id,trace_id,analysis_batch_id,analyze_started_event_id,analyze_completed_event_id,validate_started_event_id,validate_completed_event_id,generate_report_started_event_id,selection_rule_version,review_trace_status,publication_state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'complete','planned',?)`).run(
    pkg.report_id, pkg.trace_id, pkg.analysis_batch_id, pkg.analyze_started_event_id,
    pkg.analyze_completed_event_id, pkg.validate_started_event_id, pkg.validate_completed_event_id, pkg.generate_report_started_event_id,
    pkg.selection_rule_version, now,
  );
  const insert = db.prepare(`INSERT INTO report_selection_decision
    (report_id,insight_id,decision,reason_code,related_insight_id,published_rank,supporting_citation_indices,selection_rule_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const decision of pkg.decisions) insert.run(
    pkg.report_id, decision.insight_id, decision.decision, decision.reason_code,
    decision.related_insight_id ?? null, decision.published_rank ?? null,
    JSON.stringify(decision.supporting_citation_indices), pkg.selection_rule_version, now,
  );
}

/** Fail closed: the published ordering and selection whitelist must be exactly
 * the stored review decision set.  Kept citation indices are rechecked against
 * the validator's pass/support whitelist at the publication boundary. */
export function assertReviewPackageForPublish(
  db: DB, reportId: string, insightIds: readonly string[], effect?: ReviewPackageEffectBinding,
): void {
  const snapshot = db.prepare(`SELECT trace_id,publication_state,review_trace_status,analysis_batch_id,analyze_started_event_id,validate_started_event_id,validate_completed_event_id,generate_report_started_event_id
    FROM report_review_snapshot WHERE report_id=?`).get(reportId) as {
      trace_id: string; publication_state: string; review_trace_status: string; analysis_batch_id: string; analyze_started_event_id: string;
      validate_started_event_id: string | null; validate_completed_event_id: string; generate_report_started_event_id: string;
    } | undefined;
  if (!snapshot || snapshot.publication_state !== "planned" || snapshot.review_trace_status !== "complete" || !snapshot.validate_started_event_id) throw new Error("report_review_package_missing_or_not_planned");
  if (effect && (snapshot.trace_id !== effect.traceId || snapshot.generate_report_started_event_id !== effect.eventId)) {
    throw new Error("report_review_effect_binding_mismatch");
  }
  if (!hasCompleteContext(eventMeta(db, snapshot.analyze_started_event_id), ["analyzer_model", "analyzer_prompt_hash", "analyzer_output_version", "analyzer_cache_mode", "coverage_model", "coverage_prompt_hash", "coverage_thinking", "coverage_thinking_source"])
    || !hasCompleteContext(eventMeta(db, snapshot.validate_started_event_id), ["validator_model", "validator_prompt_hash", "validator_thinking", "validator_cache_mode"])
    || !hasCompleteContext(eventMeta(db, snapshot.validate_completed_event_id), ["validator_model", "validator_prompt_hash", "validator_thinking", "validator_cache_mode"])
    || !hasCompleteContext(eventMeta(db, snapshot.generate_report_started_event_id), ["report_selection_rule", "report_renderer"])) {
    throw new Error("report_review_trace_binding_invalid");
  }
  const rows = db.prepare(`SELECT d.insight_id,d.decision,d.published_rank,d.supporting_citation_indices,s.analysis_batch_id
    FROM report_selection_decision d JOIN report_review_snapshot s ON s.report_id=d.report_id WHERE d.report_id=?`).all(reportId) as Array<{ insight_id: string; decision: string; published_rank: number | null; supporting_citation_indices: string; analysis_batch_id: string }>;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM insight WHERE batch_id=?").get(snapshot.analysis_batch_id) as { n: number }).n;
  if (rows.length !== total || new Set(rows.map((row) => row.insight_id)).size !== total) throw new Error("report_review_decisions_not_complete");
  const published = rows.filter((x) => x.decision === "published").sort((a, b) => (a.published_rank ?? 0) - (b.published_rank ?? 0));
  if (published.length !== insightIds.length || published.some((x, i) => x.insight_id !== insightIds[i] || x.published_rank !== i + 1)) throw new Error("report_review_published_set_mismatch");
  for (const row of published) {
    let indices: unknown;
    try { indices = JSON.parse(row.supporting_citation_indices); } catch { throw new Error("report_review_citation_indices_invalid"); }
    if (!Array.isArray(indices) || indices.length === 0 || indices.some((index) => !Number.isSafeInteger(index) || index < 0)) throw new Error("report_review_citation_indices_invalid");
    for (const index of indices) {
      const valid = db.prepare(`SELECT 1 FROM citation_check WHERE batch_id=? AND insight_id=? AND citation_index=?
        AND verdict='pass' AND consistency='support'`).get(row.analysis_batch_id, row.insight_id, index);
      if (!valid) throw new Error("report_review_citation_not_publishable");
    }
  }
}

export function publishReviewPackage(db: DB, reportId: string): void {
  const result = db.prepare("UPDATE report_review_snapshot SET publication_state='published' WHERE report_id=? AND publication_state='planned'").run(reportId);
  if (result.changes !== 1) throw new Error("report_review_package_publish_failed");
}

export interface ReportReviewRow {
  report_id: string; trace_id: string; analysis_batch_id: string; selection_rule_version: string;
  created_at: string; decision_count: number;
}

/** Admin DTO source: a published snapshot only. Decision rows are deliberately
 * loaded through the bounded page helper below, never as an unbounded sidecar. */
export function getPublishedReportReview(db: DB, reportId: string): ReportReviewRow | null {
  return (db.prepare(`SELECT s.report_id,s.trace_id,s.analysis_batch_id,s.selection_rule_version,s.created_at,COUNT(d.insight_id) AS decision_count
    FROM report_review_snapshot s LEFT JOIN report_selection_decision d ON d.report_id=s.report_id
    WHERE s.report_id=? AND s.publication_state='published'
      AND s.review_trace_status='complete' AND s.validate_started_event_id IS NOT NULL
    GROUP BY s.report_id`).get(reportId) as ReportReviewRow | undefined) ?? null;
}

export type ReportReviewDecisionPage = { total: number; items: ReviewDecision[] };
const REVIEW_PAGE_LIMIT_MAX = 100;
const boundedText = (value: string | null | undefined, max: number): string | null => value == null ? null : value.slice(0, max);

/** Bounded admin DTO: no candidate-audit decision payload is joined or returned. */
export function listPublishedReportReviewDecisions(
  db: DB, reportId: string, opts: { limit: number; offset: number },
): ReportReviewDecisionPage | null {
  const limit = Number.isSafeInteger(opts.limit) ? Math.max(1, Math.min(opts.limit, REVIEW_PAGE_LIMIT_MAX)) : REVIEW_PAGE_LIMIT_MAX;
  const offset = Number.isSafeInteger(opts.offset) ? Math.max(0, Math.min(opts.offset, 1_000_000)) : 0;
  const published = db.prepare(`SELECT 1 FROM report_review_snapshot
    WHERE report_id=? AND publication_state='published'
      AND review_trace_status='complete' AND validate_started_event_id IS NOT NULL`).get(reportId);
  if (!published) return null;
  const total = (db.prepare("SELECT COUNT(*) AS count FROM report_selection_decision WHERE report_id=?").get(reportId) as { count: number }).count;
  const rows = db.prepare(`SELECT insight_id,decision,reason_code,related_insight_id,published_rank,supporting_citation_indices
    FROM report_selection_decision WHERE report_id=?
    ORDER BY CASE decision WHEN 'published' THEN 0 ELSE 1 END,published_rank,insight_id LIMIT ? OFFSET ?`).all(
    reportId, limit, offset,
  ) as Array<Omit<ReviewDecision, "supporting_citation_indices"> & { supporting_citation_indices: string }>;
  return { total, items: rows.map((row) => {
    let supporting: unknown;
    try { supporting = JSON.parse(row.supporting_citation_indices); } catch { throw new Error("report_review_citation_indices_invalid"); }
    if (!Array.isArray(supporting) || supporting.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("report_review_citation_indices_invalid");
    }
    return {
      insight_id: boundedText(row.insight_id, 128) ?? "",
      decision: row.decision,
      reason_code: boundedText(row.reason_code, 96) ?? "",
      related_insight_id: boundedText(row.related_insight_id, 128),
      published_rank: row.published_rank,
      supporting_citation_indices: supporting as number[],
    };
  }) };
}
