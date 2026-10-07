/** Offline preparation only. No application DB, model call, or publication permission. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { EntityRef } from "../../src/lib/db/provenance-facts.js";
import { renderReviewWorksheet } from "./data-review.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const utc = z.string().refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, "canonical UTC required");
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("object_required");
  return v as Record<string, unknown>;
};
const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error("array_required"); return v; };
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const key = (id: string, revision: string) => JSON.stringify([id, revision]);
const idOf = (ref: EntityRef): string => {
  if (ref.type !== "content_item" || ref.locator.kind !== "id" || !ref.locator.id || !ref.revision) throw new Error("source_revision_ref_required");
  return ref.locator.id;
};
const review = z.object({ kind: z.literal("human"), reviewer: text, reviewed_at: utc, receipt_path: text, receipt_sha256: sha }).strict();
type Review = z.infer<typeof review>;
const boundResource = z.object({ path: text, sha256: sha }).strict();
type Resource = z.infer<typeof boundResource>;
const configSchema = z.object({
  topic: z.literal("t_code_agents"),
  reader_goal: text,
  legacy_partition: boundResource,
  legacy_labels: boundResource,
  runs: z.array(z.object({ run_id: text, scheduled_at: utc, export_dir: text.nullable() }).strict()).min(1),
}).strict();
export type PrepareConfig = z.infer<typeof configSchema>;

export interface SourceOccurrence {
  occurrence_id: string;
  run_id: string;
  attempt_id: string;
  source_key: string;
  ref: EntityRef;
  body_sha256: string | null;
  body: string | null;
  body_kind: string;
  title: string;
  url: string;
  evidence_gaps: string[];
  family_component: string | null;
  partition: "exploration" | "unknown";
}
export interface PreparedData {
  schema_version: "rich-brief-stage0-input-v1";
  topic: "t_code_agents";
  reader_goal: string;
  resources: Resource[];
  runs: { run_id: string; scheduled_at: string; status: "observed" | "unknown"; attempt_ids: string[] }[];
  attempts: { attempt_id: string; run_id: string; kind: string; observed_candidates: number; total_candidates: number | "unknown"; input_status: "recorded" | "unknown"; cutoff: string | "unknown" }[];
  occurrences: SourceOccurrence[];
  exposure: { source_versions: number; known_components: number; known_edges: number; formal_holdout: 0; component_by_source: Record<string, string>; semantic_family_completeness: "unknown" };
  inherited_labels: Resource;
}

function resource(path: string): Resource {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("absolute_regular_resource_required");
  return { path, sha256: hash(readFileSync(path)) };
}
function verifyResource(r: Resource): void {
  if (resource(r.path).sha256 !== r.sha256) throw new Error("resource_hash_mismatch");
}

/** Keep the old connected components as a lower bound; unknown relations stay unknown. */
export function exposurePartition(raw: unknown): PreparedData["exposure"] {
  const data = obj(raw);
  const sources = array(data.source_versions).map(obj);
  if (array(data.formal_holdout).length) throw new Error("old_exposure_cannot_be_formal_holdout");
  const parents = new Map<string, string>();
  const units = new Map<string, string[]>();
  const components = new Map<string, string[]>();
  function find(k: string): string { const p = parents.get(k); if (!p) throw new Error("family_node_missing"); if (p === k) return k; const root = find(p); parents.set(k, root); return root; }
  function union(a: string, b: string): void { const ra = find(a), rb = find(b); if (ra !== rb) parents.set(rb, ra < rb ? ra : rb), parents.set(ra, ra < rb ? ra : rb); }
  for (const source of sources) {
    if (source.partition !== "exploration") throw new Error("exposed_source_must_stay_exploration");
    const k = key(text.parse(source.content_item_id), text.parse(source.revision));
    if (parents.has(k)) throw new Error("duplicate_exposed_revision");
    parents.set(k, k);
    for (const u of array(source.source_unit_ids)) { const unit = text.parse(u); units.set(unit, [...(units.get(unit) ?? []), k]); }
    for (const c of array(source.known_family_components)) { const component = text.parse(c); components.set(component, [...(components.get(component) ?? []), k]); }
  }
  for (const family of array(data.known_family_components).map(obj)) {
    const c = text.parse(family.split_component_id);
    for (const u of array(family.source_unit_ids)) for (const k of units.get(text.parse(u)) ?? []) components.set(c, [...(components.get(c) ?? []), k]);
  }
  for (const members of [...units.values(), ...components.values()]) for (const member of members.slice(1)) union(members[0], member);
  for (const edge of array(data.known_family_edges).map(obj)) {
    const left = units.get(text.parse(edge.left)), right = units.get(text.parse(edge.right));
    if (!left?.length || !right?.length) throw new Error("unresolved_known_family_edge");
    for (const a of left) for (const b of right) union(a, b);
  }
  return { source_versions: sources.length, known_components: array(data.known_family_components).length, known_edges: array(data.known_family_edges).length,
    formal_holdout: 0, component_by_source: Object.fromEntries([...parents.keys()].sort().map((k) => [k, `family:${hash(find(k)).slice(0, 24)}`])), semantic_family_completeness: "unknown" };
}

export function prepareData(rawConfig: unknown): PreparedData {
  const config = configSchema.parse(rawConfig);
  for (const r of [config.legacy_partition, config.legacy_labels]) verifyResource(r);
  if (new Set(config.runs.map((r) => r.run_id)).size !== config.runs.length) throw new Error("duplicate_registered_run");
  const exposure = exposurePartition(json(config.legacy_partition.path));
  const result: PreparedData = { schema_version: "rich-brief-stage0-input-v1", topic: config.topic, reader_goal: config.reader_goal,
    resources: [config.legacy_partition, config.legacy_labels, resource(fileURLToPath(import.meta.url)), resource(fileURLToPath(new URL("./data-review.ts", import.meta.url)))],
    runs: [], attempts: [], occurrences: [], exposure, inherited_labels: config.legacy_labels };
  const attemptIds = new Set<string>();
  for (const run of config.runs) {
    const registered: PreparedData["runs"][number] = { run_id: run.run_id, scheduled_at: run.scheduled_at, status: "unknown", attempt_ids: [] };
    result.runs.push(registered);
    if (!run.export_dir) continue;
    const manifestPath = join(run.export_dir, "snapshot-manifest.json");
    const manifest = obj(json(manifestPath));
    if (manifest.format_version !== "brief-density-s0-v2" || JSON.stringify(manifest.topics) !== JSON.stringify([config.topic])) throw new Error("single_topic_export_v2_required");
    const window = obj(manifest.window);
    const from = utc.parse(window.from_inclusive), until = utc.parse(window.until_exclusive);
    if (run.scheduled_at < from || run.scheduled_at >= until) throw new Error("registered_run_outside_export_window");
    const time = obj(manifest.snapshot_time_evidence);
    if (time.status !== "db_interval_no_external_commit_observed" || utc.parse(time.completed_at) !== utc.parse(manifest.as_of)
      || String(time.completed_at) < run.scheduled_at || Date.parse(String(time.completed_at)) >= Date.parse(run.scheduled_at) + 86400000) throw new Error("attested_in_run_backup_required");
    result.resources.push(resource(manifestPath));
    const hashes = obj(manifest.artifact_hashes);
    for (const file of ["candidate-pool.jsonl", "stage-loss.json"]) {
      const r = resource(join(run.export_dir, file));
      if (sha.parse(hashes[file]) !== r.sha256) throw new Error("export_artifact_hash_mismatch");
      result.resources.push(r);
    }
    const records = readFileSync(join(run.export_dir, "candidate-pool.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => obj(JSON.parse(line)));
    let unlinkedInput = false;
    for (const record of records) {
      if (!["batch", "trace_without_batch"].includes(String(record.kind))) throw new Error("unknown_export_record_kind");
      const batch = record.kind === "batch" ? obj(record.batch) : null;
      if ((batch?.topic_id ?? record.topic_id) !== config.topic) throw new Error("foreign_topic_record");
      const starts = batch ? array(record.analysis_links).map(obj).map((link) => link.started) : [record.started];
      if (!starts.length || starts.some((s) => !s)) { unlinkedInput = true; continue; }
      for (const startRaw of starts) {
        const start = obj(startRaw);
        const attemptId = `${text.parse(start.trace_id)}:${z.number().int().nonnegative().parse(start.attempt)}`;
        if (attemptIds.has(attemptId)) throw new Error("attempt_reused_across_registered_runs");
        attemptIds.add(attemptId); registered.attempt_ids.push(attemptId);
        const startedAt = utc.parse(start.occurred_at);
        if (startedAt < from || startedAt >= until) throw new Error("attempt_outside_export_window");
        // Batch sources are a union across links: use the exact start refs to retain occurrences for each attempt.
        const refs = array(JSON.parse(text.parse(start.input_refs))).map(obj).filter((ref) => ref.type === "content_item") as unknown as EntityRef[];
        const inputs = array(record.input_evidence).map(obj);
        const candidates = record.candidates === null ? [] : array(record.candidates);
        let cutoff: string | "unknown" = "unknown";
        if (batch?.time_window) { const w = obj(typeof batch.time_window === "string" ? JSON.parse(batch.time_window) : batch.time_window); cutoff = utc.parse(w.end); }
        result.attempts.push({ attempt_id: attemptId, run_id: run.run_id, kind: String(record.kind), observed_candidates: candidates.length,
          total_candidates: batch ? candidates.length : "unknown", input_status: refs.length ? "recorded" : "unknown", cutoff });
        for (const ref of refs) {
          const sourceKey = key(idOf(ref), ref.revision!);
          const matches = inputs.filter((input) => { const candidateRef = input.ref as EntityRef; return key(idOf(candidateRef), candidateRef.revision!) === sourceKey; });
          if (matches.length > 1) throw new Error("duplicate_input_evidence_binding");
          const source = matches[0];
          const body = source && typeof source.body === "string" ? source.body : null;
          const bodyHash = source?.body_sha256 === null || !source ? null : sha.parse(source.body_sha256);
          if (body !== null && hash(body) !== bodyHash) throw new Error("body_hash_mismatch");
          const snapshot = source?.snapshot ? obj(source.snapshot) : null;
          const gaps = source ? array(source.gaps).map((g) => text.parse(g)) : ["source_binding_missing"];
          const component = exposure.component_by_source[sourceKey] ?? null;
          result.occurrences.push({ occurrence_id: `occ:${hash(JSON.stringify([run.run_id, attemptId, sourceKey])).slice(0, 24)}`, run_id: run.run_id,
            attempt_id: attemptId, source_key: sourceKey, ref, body_sha256: bodyHash, body, body_kind: String(snapshot?.body_kind ?? "unknown"),
            title: String(snapshot?.title ?? "unknown"), url: String(snapshot?.url ?? "unknown"),
            evidence_gaps: gaps, family_component: component, partition: component ? "exploration" : "unknown" });
        }
      }
    }
    registered.status = registered.attempt_ids.length && !unlinkedInput ? "observed" : "unknown";
  }
  if (new Set(result.occurrences.map((o) => o.occurrence_id)).size !== result.occurrences.length) throw new Error("duplicate_source_occurrence");
  return result;
}

const span = z.object({ occurrence_id: text, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text }).strict();
const labelsSchema = z.object({
  schema_version: z.literal("rich-brief-stage0-labels-v1"), input_sha256: sha,
  review: review.nullable(),
  sources: z.array(z.object({ occurrence_id: text, status: z.enum(["pending", "complete", "unknown"]), event_ids: z.array(text),
    no_in_scope_event_reason: z.string(), family_status: z.enum(["pending", "reviewed", "unknown"]) }).strict()),
  events: z.array(z.object({ event_id: text, identity: z.object({ subject: text, action: text, object_version: text, time: text }).strict(),
    importance: z.enum(["important", "secondary", "out_of_scope"]), importance_reason: text,
    dimensions: z.array(z.object({ dimension_id: text, claim: text, importance: z.enum(["must", "secondary"]), evidence: z.array(span).min(1),
      necessary_qualifiers: z.array(text), qualifier_review: z.literal("complete"), distinctness_reason: text }).strict()),
    questions: z.array(z.object({ question_id: text, question: text, answer: text, dimension_ids: z.array(text).min(1) }).strict()),
    inherited_label_refs: z.array(text),
  }).strict()),
}).strict();
export type HumanLabels = z.infer<typeof labelsSchema>;
export function pendingLabels(data: PreparedData, inputSha256: string): HumanLabels {
  return { schema_version: "rich-brief-stage0-labels-v1", input_sha256: inputSha256, review: null,
    sources: data.occurrences.map((o) => ({ occurrence_id: o.occurrence_id, status: "pending", event_ids: [], no_in_scope_event_reason: "", family_status: "pending" })), events: [] };
}

export const requiredNumbers = ["min_complete_runs", "min_important_events", "min_important_dimensions", "min_applicable_events", "min_new_publishable_dimensions",
  "min_gain_ratio", "min_key_event_recall_delta", "min_dimension_coverage_delta", "max_rebroadcast_ratio_delta", "max_empty_issue_ratio_delta", "max_unknown_ratio",
  "max_reader_seconds", "max_facts_per_issue", "min_reading_correctness_delta", "min_blind_readers", "min_prospective_runs", "max_cost_usd", "max_tokens",
  "max_elapsed_ms", "max_failure_ratio", "stop_after_runs"] as const;
const numericDecision = z.object({ value: z.number().finite(), rationale: text, evidence_resource_sha256: sha, approval: review }).strict();
const arm = z.object({ arm_id: text, task: z.enum(["baseline", "first_extraction", "freshness", "paper", "podcast", "bounded_implication"]),
  input_sha256: sha, model: text, provider: text, model_revision: text, prompt_sha256: sha,
  token_budget: z.number().int().positive(), cost_budget_usd: z.number().positive(), timeout_ms: z.number().int().positive(),
  max_attempts: z.number().int().positive(), failure_policy: text, cost_accounting: text, stop_rule: text, ledger_schema_sha256: sha }).strict();
const protocolSchema = z.object({
  schema_version: z.literal("rich-brief-stage0-protocol-v1"), topic: z.literal("t_code_agents"), input_sha256: sha, labels_sha256: sha,
  review: review, numbers: z.record(z.string(), numericDecision), resources: z.array(boundResource).min(1), arms: z.array(arm).min(2),
  source_family_policy: z.literal("connected_exposure_excluded_unknown_quarantined"),
  gold_visibility: z.literal("scorer_only_not_extractor"),
  holdout: z.object({ status: z.literal("unseen_prospective_uncollected"), starts_at: utc, ends_at: utc,
    registered_run_ids: z.array(text).min(1), all_scheduled_runs_and_attempts: z.literal(true), source_family_audit_before_score: z.literal(true),
    opened_at: z.null(), formal_results_seen: z.literal(false), attestation: review }).strict(),
  safety: z.object({ unsupported_assertions: z.literal(0), wrong_event_merges: z.literal(0), missing_necessary_qualifiers: z.literal(0),
    blocked_or_unvalidated_citations: z.literal(0), unsafe_accept: z.literal(0) }).strict(),
  production_enabled: z.literal(false), b1_status: z.literal("no_go"),
}).strict();
export type FreezeProtocol = z.infer<typeof protocolSchema>;

export interface Readiness { status: "blocked" | "ready_for_freeze"; blockers: string[]; counts: { runs: number; attempts: number; inputs: number; inherited_events: number; important_events: number; important_dimensions: number; formal_holdout: 0 } }
export function checkReadiness(data: PreparedData, inputSha256: string, rawLabels: unknown, rawProtocol: unknown, now = new Date().toISOString(), labelsSha256 = hash(JSON.stringify(rawLabels, null, 2) + "\n")): Readiness {
  utc.parse(now);
  const blockers: string[] = [];
  const labelsParsed = labelsSchema.safeParse(rawLabels), protocolParsed = protocolSchema.safeParse(rawProtocol);
  const add = (code: string) => { if (!blockers.includes(code)) blockers.push(code); };
  if (data.schema_version !== "rich-brief-stage0-input-v1" || data.topic !== "t_code_agents") throw new Error("prepared_input_schema_invalid");
  const legacy = obj(json(data.inherited_labels.path));
  const inheritedEvents = array(legacy.events).length;
  const counts = { runs: data.runs.length, attempts: data.attempts.length, inputs: data.occurrences.length, inherited_events: inheritedEvents, important_events: 0, important_dimensions: 0, formal_holdout: 0 as const };
  for (const r of data.resources) { try { verifyResource(r); } catch { add("input_resource_changed_or_missing"); } }
  if (data.runs.some((r) => r.status === "unknown") || data.attempts.some((a) => a.input_status === "unknown")) add("complete_run_input_denominator_unknown");
  if (!labelsParsed.success) add("human_labels_schema_invalid");
  else {
    const labels = labelsParsed.data;
    if (labels.input_sha256 !== inputSha256) add("human_labels_input_hash_mismatch");
    if (!labels.review) add("human_gold_not_confirmed");
    else { try { verifyResource({ path: labels.review.receipt_path, sha256: labels.review.receipt_sha256 }); } catch { add("human_review_receipt_missing_or_changed"); }
      if (labels.review.reviewed_at > now) add("human_gold_review_in_future"); }
    const sources = new Map(data.occurrences.map((o) => [o.occurrence_id, o]));
    const labelIds = labels.sources.map((s) => s.occurrence_id);
    if (new Set(labelIds).size !== labelIds.length || labelIds.length !== sources.size || labelIds.some((id) => !sources.has(id))) add("full_input_gold_coverage_mismatch");
    if (labels.sources.some((s) => s.status !== "complete" || s.family_status !== "reviewed")) add("full_input_event_or_family_gold_pending");
    const eventIds = labels.events.map((e) => e.event_id);
    if (new Set(eventIds).size !== eventIds.length) add("duplicate_gold_event");
    const allDimensions = labels.events.flatMap((e) => e.dimensions);
    const dimensionIds = allDimensions.map((d) => d.dimension_id);
    if (new Set(dimensionIds).size !== dimensionIds.length) add("duplicate_gold_dimension");
    const questionIds = labels.events.flatMap((e) => e.questions.map((q) => q.question_id));
    if (new Set(questionIds).size !== questionIds.length) add("duplicate_reading_question");
    for (const source of labels.sources) {
      if ((!source.event_ids.length && !source.no_in_scope_event_reason.trim()) || source.event_ids.some((id) => !eventIds.includes(id))) add("source_event_or_negative_decision_missing");
      const input = sources.get(source.occurrence_id);
      if (!input?.body || input.evidence_gaps.length) add("full_input_evidence_gap_requires_resolution");
    }
    for (const event of labels.events) {
      if (!labels.sources.some((s) => s.event_ids.includes(event.event_id))) add("gold_event_unassigned");
      if (event.importance === "important") {
        counts.important_events++;
        counts.important_dimensions += event.dimensions.filter((d) => d.importance === "must").length;
        if (!event.dimensions.some((d) => d.importance === "must") || !event.questions.length) add("important_event_dimensions_or_reading_questions_missing");
      }
      const ownDimensions = event.dimensions.map((d) => d.dimension_id);
      for (const q of event.questions) if (q.dimension_ids.some((id) => !ownDimensions.includes(id))) add("reading_question_dimension_mismatch");
      for (const dimension of event.dimensions) for (const evidence of dimension.evidence) {
        const source = sources.get(evidence.occurrence_id);
        if (!source?.body || evidence.end <= evidence.start || source.body.slice(evidence.start, evidence.end) !== evidence.quote) add("gold_evidence_span_mismatch");
        if (!labels.sources.some((s) => s.occurrence_id === evidence.occurrence_id && s.event_ids.includes(event.event_id))) add("gold_evidence_event_assignment_mismatch");
      }
    }
  }
  if (!protocolParsed.success) add("t04_protocol_schema_or_numeric_decisions_pending");
  else {
    const p = protocolParsed.data;
    if (p.input_sha256 !== inputSha256 || p.labels_sha256 !== labelsSha256) add("t04_input_or_labels_hash_mismatch");
    const resourceHashes = new Set(p.resources.map((r) => r.sha256));
    if (new Set(p.resources.map((r) => r.path)).size !== p.resources.length) add("duplicate_protocol_resource_path");
    for (const r of p.resources) { try { verifyResource(r); } catch { add("protocol_resource_changed_or_missing"); } }
    const verifyReview = (r: Review) => {
      if (r.reviewed_at > now || !resourceHashes.has(r.receipt_sha256) || !p.resources.some((entry) => entry.path === r.receipt_path && entry.sha256 === r.receipt_sha256)) add("protocol_human_receipt_not_bound");
    };
    verifyReview(p.review); verifyReview(p.holdout.attestation);
    if (p.holdout.starts_at <= now || p.holdout.ends_at <= p.holdout.starts_at) add("formal_holdout_must_start_after_freeze");
    if (new Set(p.holdout.registered_run_ids).size !== p.holdout.registered_run_ids.length || p.holdout.registered_run_ids.some((id) => data.runs.some((r) => r.run_id === id))) add("holdout_registered_runs_duplicate_or_exposed");
    if (new Set(Object.keys(p.numbers)).size !== requiredNumbers.length || requiredNumbers.some((name) => !p.numbers[name])) add("required_numeric_protocol_incomplete");
    for (const [name, decision] of Object.entries(p.numbers)) {
      if (!requiredNumbers.includes(name as typeof requiredNumbers[number])) add("unexpected_numeric_protocol_key");
      if (!resourceHashes.has(decision.evidence_resource_sha256)) add("numeric_basis_not_bound_to_resource");
      verifyReview(decision.approval);
      if ((name.startsWith("min_") && !name.endsWith("_delta") || name.startsWith("max_") && !name.endsWith("_delta") || name === "stop_after_runs") && decision.value < 0) add("negative_count_budget_or_ratio");
      if ((name.includes("ratio") || name.endsWith("_delta")) && Math.abs(decision.value) > 1) add("ratio_or_delta_out_of_range");
      if (["min_gain_ratio", "max_cost_usd"].includes(name) && decision.value <= 0) add("positive_gain_and_cost_budget_required");
      if (["min_key_event_recall_delta", "min_dimension_coverage_delta"].includes(name) && decision.value < 0
        || ["max_rebroadcast_ratio_delta", "max_empty_issue_ratio_delta"].includes(name) && decision.value > 0) add("noninferiority_cannot_allow_regression");
      if (["min_complete_runs", "min_important_events", "min_important_dimensions", "min_applicable_events", "min_new_publishable_dimensions", "max_reader_seconds", "max_facts_per_issue", "min_blind_readers", "min_prospective_runs", "max_tokens", "max_elapsed_ms", "stop_after_runs"].includes(name) && (!Number.isSafeInteger(decision.value) || decision.value <= 0)) add("positive_integer_protocol_required");
    }
    if (p.numbers.min_complete_runs && data.runs.filter((r) => r.status === "observed" && data.attempts.some((a) => a.run_id === r.run_id && a.kind === "batch")).length < p.numbers.min_complete_runs.value) add("exploration_run_sample_below_protocol");
    if (p.numbers.min_important_events && counts.important_events < p.numbers.min_important_events.value) add("important_event_gold_below_protocol");
    if (p.numbers.min_important_dimensions && counts.important_dimensions < p.numbers.min_important_dimensions.value) add("important_dimension_gold_below_protocol");
    if (p.numbers.min_prospective_runs && p.holdout.registered_run_ids.length < p.numbers.min_prospective_runs.value) add("prospective_registered_runs_below_protocol");
    if (p.numbers.stop_after_runs && p.numbers.min_prospective_runs && p.numbers.stop_after_runs.value < p.numbers.min_prospective_runs.value) add("stop_rule_precludes_minimum_sample");
    if (new Set(p.arms.map((a) => a.arm_id)).size !== p.arms.length || !p.arms.some((a) => a.task === "baseline") || !p.arms.some((a) => a.task === "first_extraction")) add("baseline_c1_arm_registration_missing_or_duplicate");
    for (const a of p.arms) {
      if (a.input_sha256 !== inputSha256 || !resourceHashes.has(a.prompt_sha256) || !resourceHashes.has(a.ledger_schema_sha256)) add("arm_input_prompt_or_ledger_not_bound");
      if (p.numbers.max_tokens && a.token_budget > p.numbers.max_tokens.value || p.numbers.max_cost_usd && a.cost_budget_usd > p.numbers.max_cost_usd.value
        || p.numbers.max_elapsed_ms && a.timeout_ms > p.numbers.max_elapsed_ms.value) add("arm_budget_exceeds_registered_cap");
    }
    const pair = p.arms.filter((a) => a.task === "baseline" || a.task === "first_extraction");
    const signatures = new Set(pair.map((a) => JSON.stringify([a.input_sha256, a.model, a.provider, a.model_revision, a.token_budget, a.cost_budget_usd, a.timeout_ms, a.max_attempts])));
    if (signatures.size !== 1) add("baseline_c1_model_input_or_budget_unpaired");
  }
  return { status: blockers.length ? "blocked" : "ready_for_freeze", blockers, counts };
}

/** Output only under this worktree's private staging root; refuse symlinks and overwrite. */
export function privateWrite(worktree: string, outputDir: string, artifacts: Record<string, unknown>): Record<string, string> {
  const root = realpathSync(worktree), privateRoot = join(root, ".data", "rich-brief-stage0");
  if (!existsSync(join(root, ".git"))) throw new Error("worktree_required");
  if (!isAbsolute(outputDir) || !resolve(outputDir).startsWith(`${privateRoot}/`) || resolve(outputDir) !== outputDir || existsSync(outputDir)) throw new Error("new_private_stage0_output_required");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  let cursor = privateRoot;
  while (cursor !== root) { if (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor) !== cursor) throw new Error("private_output_symlink_forbidden"); cursor = dirname(cursor); }
  if ((lstatSync(privateRoot).mode & 0o077) !== 0) throw new Error("private_root_permissions_required");
  if (dirname(outputDir) !== privateRoot) throw new Error("direct_private_child_required");
  mkdirSync(outputDir, { mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const [name, value] of Object.entries(artifacts)) {
    if (!/^[a-z0-9-]+\.(?:json|md)$/.test(name)) throw new Error("private_artifact_name_invalid");
    const bytes = name.endsWith(".md") ? text.parse(value) + "\n" : JSON.stringify(value, null, 2) + "\n";
    writeFileSync(join(outputDir, name), bytes, { mode: 0o600, flag: "wx" }); hashes[name] = hash(bytes);
  }
  return hashes;
}

export function freezeData(worktree: string, inputPath: string, labelsPath: string, protocolPath: string, outputDir: string): { sha256: string; readiness: Readiness } {
  const inputResource = resource(inputPath), labelsResource = resource(labelsPath), protocolResource = resource(protocolPath);
  const data = json(inputPath) as PreparedData, labels = json(labelsPath), protocol = protocolSchema.parse(json(protocolPath));
  const configResource = data.resources.at(-1);
  if (!configResource) throw new Error("preparation_config_resource_required");
  verifyResource(configResource);
  const regenerated = prepareData(json(configResource.path)); regenerated.resources.push(configResource);
  if (hash(JSON.stringify(regenerated, null, 2) + "\n") !== inputResource.sha256) throw new Error("prepared_input_does_not_match_original_export_resources");
  if (protocol.labels_sha256 !== labelsResource.sha256) throw new Error("protocol_must_bind_exact_labels_file_bytes");
  const frozenAt = new Date().toISOString();
  const readiness = checkReadiness(data, inputResource.sha256, labels, protocol, frozenAt, labelsResource.sha256);
  if (readiness.status !== "ready_for_freeze") throw new Error(`freeze_blocked:${readiness.blockers.join(",")}`);
  // Recheck original resources immediately before writing; the freeze records exact bytes, not a mutable filename.
  for (const r of [...data.resources, ...protocol.resources, inputResource, labelsResource, protocolResource]) verifyResource(r);
  const artifacts = privateWrite(worktree, outputDir, { "frozen-protocol.json": { schema_version: "rich-brief-stage0-freeze-v1", frozen_at: frozenAt,
    resources: [inputResource, labelsResource, protocolResource, ...data.resources, ...protocol.resources], protocol, readiness, production_enabled: false } });
  return { sha256: artifacts["frozen-protocol.json"], readiness };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  if (command === "prepare" && first && second) {
    const configResource = resource(resolve(first));
    const data = prepareData(json(configResource.path)); data.resources.push(configResource);
    const bytes = JSON.stringify(data, null, 2) + "\n";
    const labels = pendingLabels(data, hash(bytes));
    const hashes = privateWrite(process.cwd(), resolve(second), { "input-worklist.json": data, "human-labels.json": labels,
      "human-review-workbook.md": renderReviewWorksheet(data, json(data.inherited_labels.path)),
      "review-todo.json": { status: "blocked", inherited_labels: "preserved_not_reasked_not_full_input_gold", occurrence_ids: data.occurrences.map((o) => o.occurrence_id),
        decisions: ["assign every complete input to events or justify out-of-scope", "label important dimensions and necessary qualifiers before arm output", "reuse existing confirmed priorities and questions by explicit inherited refs", "review family relationships; quarantine unknowns", "register numeric protocol from exploration and human reading, before holdout"],
        formal_holdout: 0, production_enabled: false } });
    console.log(JSON.stringify({ status: "prepared_human_blocked", runs: data.runs.length, attempts: data.attempts.length, inputs: data.occurrences.length, formal_holdout: 0, artifact_hashes: hashes }));
  } else if (command === "check" && first && second && third) {
    const inputResource = resource(resolve(first));
    const labelsResource = resource(resolve(second));
    const readiness = checkReadiness(json(inputResource.path) as PreparedData, inputResource.sha256, json(labelsResource.path), json(resolve(third)), undefined, labelsResource.sha256);
    console.log(JSON.stringify(readiness)); if (readiness.status === "blocked") process.exitCode = 2;
  } else if (command === "freeze" && first && second && third && fourth) {
    console.log(JSON.stringify(freezeData(process.cwd(), resolve(first), resolve(second), resolve(third), resolve(fourth))));
  } else throw new Error("Usage: data.ts prepare CONFIG PRIVATE_OUTPUT | check INPUT LABELS PROTOCOL | freeze INPUT LABELS PROTOCOL PRIVATE_OUTPUT");
}
