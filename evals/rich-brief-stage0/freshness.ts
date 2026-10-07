/** Offline F diagnostics only. No DB bootstrap, source fetch, model, or strategy mutation. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const utc = z.string().refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, "canonical UTC required");
const id = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const clockSchema = z.object({
  value: utc.nullable(), basis: z.enum(["source_metadata", "observer", "generation_event", "artifact_commit", "unknown"]),
  evidence_ref: id.nullable(), unknown_reason: id.nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.value === null ? v.basis !== "unknown" || !v.unknown_reason : v.basis === "unknown" || !v.evidence_ref || v.unknown_reason !== null)
    ctx.addIssue({ code: "custom", message: "clock requires evidence or explicit unknown reason" });
});
export const CLOCKS = ["event_at", "recorded_at", "source_published", "source_version_updated", "first_available", "first_collected", "selected", "extracted", "evidence_pass", "published", "reader_open"] as const;
const clocksSchema = z.object(Object.fromEntries(CLOCKS.map((k) => [k, clockSchema])) as Record<typeof CLOCKS[number], typeof clockSchema>).strict();
const form = z.enum(["article", "paper_abstract", "paper_fulltext", "show_notes", "transcript", "mixed", "unknown"]);
const kind = z.enum(["first", "deep_read_followup", "analysis_revisit", "unknown"]);
const budgetSchema = z.object({
  model: id.nullable(), input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(),
  usd: z.number().nonnegative().nullable(), failure_code: id.nullable(),
}).strict();
const attemptSchema = z.object({
  attempt_id: id, topic_id: id, issue_id: id, status: z.enum(["completed", "failed", "unknown"]),
  input_source_revisions: z.array(id), analyzer_started: clockSchema, analyzer_completed: clockSchema, ledger: budgetSchema,
}).strict();
const observationSchema = z.object({
  observation_id: id, attempt_id: id, source_revision: id, source_family: id.nullable(),
  topic_id: id, issue_id: id, source_form: form, publication_kind: kind, clocks: clocksSchema,
  terminal: z.enum(["published", "not_selected", "extraction_failed", "evidence_rejected", "history_filtered", "budget_filtered", "unknown"]),
}).strict();
const publicationSchema = z.object({
  publication_id: id, attempt_id: id.nullable(), topic_id: id, issue_id: id, source_form: form, publication_kind: kind,
  event_id: id.nullable(), proposition_id: id.nullable(), primary_source_revision: id.nullable(), clocks: clocksSchema,
}).strict();
export const freshnessInputSchema = z.object({
  format_version: z.literal("rich-brief-freshness-v1"), mode: z.enum(["historical_exploratory", "prospective_observation"]),
  as_of: utc, window: z.object({ from_inclusive: utc, until_exclusive: utc }).strict(),
  provenance: z.object({ input_sha256: sha.nullable(), resource_version: id, scope: id, gaps: z.array(id) }).strict(),
  comparison: z.object({
    arm: id, complete_source_pool_sha256: sha.nullable(), complete_source_pool: z.boolean(),
    model: id.nullable(), token_budget: z.number().int().nonnegative().nullable(), usd_budget: z.number().nonnegative().nullable(),
    paired_run_id: id.nullable(),
  }).strict(),
  reader_scenario_at: utc.nullable(), attempts: z.array(attemptSchema), observations: z.array(observationSchema),
  publications: z.array(publicationSchema), candidate_terminal_counts: z.record(id, z.number().int().nonnegative()),
}).strict().superRefine((v, ctx) => {
  if (v.window.from_inclusive >= v.window.until_exclusive || v.as_of < v.window.until_exclusive)
    ctx.addIssue({ code: "custom", message: "invalid observation window" });
  for (const list of [v.attempts.map((a) => a.attempt_id), v.observations.map((o) => o.observation_id), v.publications.map((p) => p.publication_id)])
    if (new Set(list).size !== list.length) ctx.addIssue({ code: "custom", message: "duplicate row identity" });
  const attempts = new Map(v.attempts.map((a) => [a.attempt_id, a]));
  for (const attempt of v.attempts) for (const c of [attempt.analyzer_started, attempt.analyzer_completed])
    if (c.value !== null && c.value > v.as_of)
      ctx.addIssue({ code: "custom", message: "attempt clock beyond as_of" });
  for (const row of [...v.observations, ...v.publications]) {
    const attempt = row.attempt_id === null ? null : attempts.get(row.attempt_id);
    if (row.attempt_id !== null && (!attempt || attempt.topic_id !== row.topic_id || attempt.issue_id !== row.issue_id))
      ctx.addIssue({ code: "custom", message: "attempt binding mismatch" });
    for (const c of CLOCKS) if (row.clocks[c].value !== null && row.clocks[c].value! > v.as_of)
      ctx.addIssue({ code: "custom", message: "clock beyond as_of" });
  }
  for (const row of v.observations) if (!attempts.get(row.attempt_id)?.input_source_revisions.includes(row.source_revision))
    ctx.addIssue({ code: "custom", message: "input revision not in attempt ledger" });
});
export type FreshnessInput = z.infer<typeof freshnessInputSchema>;
type Clock = z.infer<typeof clockSchema>;
type Clocks = z.infer<typeof clocksSchema>;
type Publication = z.infer<typeof publicationSchema>;

export const unknownClock = (reason: string): Clock => ({ value: null, basis: "unknown", evidence_ref: null, unknown_reason: reason });
export const unknownClocks = (): Clocks => Object.fromEntries(CLOCKS.map((k) => [k, unknownClock(`not_observed:${k}`)])) as Clocks;
function recordedClock(value: unknown, basis: Clock["basis"], evidence: string): Clock {
  // Date-only source metadata has no verified hour. SQLite default datetime is explicitly UTC.
  if (typeof value !== "string") return unknownClock("missing_timestamp");
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) && basis === "generation_event"
    ? value.replace(" ", "T") + "Z" : value;
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) return unknownClock("timestamp_precision_or_timezone_unknown");
  return { value: new Date(normalized).toISOString(), basis, evidence_ref: evidence, unknown_reason: null };
}
export function durationHours(start: Clock, end: Clock): number | "unknown" | "invalid_negative" {
  if (start.value === null || end.value === null) return "unknown";
  const hours = (Date.parse(end.value) - Date.parse(start.value)) / 3_600_000;
  return hours < 0 ? "invalid_negative" : hours;
}
/** Protocol check only; neither this nor metadata completeness is an F outcome/publish gate. */
export function assertComparableFInputs(left: unknown, right: unknown): void {
  const a = freshnessInputSchema.parse(left), b = freshnessInputSchema.parse(right);
  for (const input of [a, b]) {
    const c = input.comparison;
    if (input.mode !== "prospective_observation" || !c.complete_source_pool || c.complete_source_pool_sha256 === null
      || c.model === null || c.token_budget === null || c.usd_budget === null || c.paired_run_id === null) throw new Error("F_comparison_protocol_incomplete");
    if (input.attempts.some((attempt) => attempt.ledger.model !== c.model || attempt.ledger.input_tokens === null || attempt.ledger.output_tokens === null || attempt.ledger.usd === null))
      throw new Error("F_attempt_cost_or_model_ledger_incomplete");
    const tokens = input.attempts.reduce((n, attempt) => n + attempt.ledger.input_tokens! + attempt.ledger.output_tokens!, 0);
    const cost = input.attempts.reduce((n, attempt) => n + attempt.ledger.usd!, 0);
    if (tokens > c.token_budget || cost > c.usd_budget) throw new Error("F_comparison_budget_exceeded");
  }
  for (const key of ["complete_source_pool_sha256", "model", "token_budget", "usd_budget", "paired_run_id"] as const)
    if (a.comparison[key] !== b.comparison[key]) throw new Error(`F_comparison_mismatch:${key}`);
  if (a.comparison.arm === b.comparison.arm || a.as_of !== b.as_of || JSON.stringify(a.window) !== JSON.stringify(b.window)) throw new Error("F_comparison_arms_or_window_mismatch");
}
function distribution(values: ReturnType<typeof durationHours>[]) {
  const known = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const percentile = (p: number) => known.length ? known[Math.ceil(p * known.length) - 1] : null;
  const within24 = known.filter((h) => h <= 24).length, within48 = known.filter((h) => h <= 48).length;
  return { total: values.length, known: known.length, unknown: values.filter((v) => v === "unknown").length,
    invalid_negative: values.filter((v) => v === "invalid_negative").length, p50_hours: percentile(.5), p90_hours: percentile(.9),
    within24_count: within24, within48_count: within48,
    within24_of_known: known.length ? within24 / known.length : null, within48_of_known: known.length ? within48 / known.length : null,
    within24_of_total_lower_bound: values.length ? within24 / values.length : null,
    within48_of_total_lower_bound: values.length ? within48 / values.length : null };
}
const SEGMENTS = [
  ["first_available", "first_collected"], ["first_collected", "selected"], ["selected", "extracted"],
  ["extracted", "evidence_pass"], ["evidence_pass", "published"], ["first_available", "published"],
] as const;
const PIPELINE_CLOCKS = ["first_available", "first_collected", "selected", "extracted", "evidence_pass", "published", "reader_open"] as const;
/** Terminal labels only attribute loss to their proved failure stage; missing earlier clocks do not. */
function isProvedStageLoss(observation: FreshnessInput["observations"][number], from: string, to: string): boolean {
  const failedSegment: Partial<Record<FreshnessInput["observations"][number]["terminal"], readonly [string, string]>> = {
    not_selected: ["first_collected", "selected"], extraction_failed: ["selected", "extracted"],
    evidence_rejected: ["extracted", "evidence_pass"], history_filtered: ["evidence_pass", "published"],
    // budget_filtered does not identify whether input selection or report selection exhausted a budget.
  };
  const segment = failedSegment[observation.terminal];
  if (!segment || segment[0] !== from || segment[1] !== to) return false;
  const targetIndex = PIPELINE_CLOCKS.findIndex((c) => c === to);
  return !PIPELINE_CLOCKS.slice(targetIndex + 1).some((c) => observation.clocks[c].value !== null);
}
function publicationMetrics(rows: Publication[], scenario: string | null) {
  const age = (key: keyof Clocks) => distribution(rows.map((p) => durationHours(p.clocks[key], p.clocks.published)));
  return { publication_messages: rows.length, original_publish_age: age("source_published"), version_update_age: age("source_version_updated"),
    availability_to_publication: age("first_available"), reader_open_age: distribution(rows.map((p) => durationHours(p.clocks.source_published, p.clocks.reader_open))),
    reader_scenario_age: scenario === null ? null : { kind: "scenario_estimate_only", at: scenario,
      ...distribution(rows.map((p) => durationHours(p.clocks.source_published, { value: scenario, basis: "observer", evidence_ref: "fixed_reading_scenario", unknown_reason: null }))) } };
}
export function summarizeFreshness(raw: unknown) {
  const input = freshnessInputSchema.parse(raw);
  const grouping: Record<string, Publication[]> = { all: input.publications };
  // Failed/empty issues remain visible with zero publication-age samples.
  for (const a of input.attempts) { grouping[`topic:${a.topic_id}`] ??= []; grouping[`issue:${a.issue_id}`] ??= []; }
  for (const p of input.publications) {
    const dimensions = { topic: p.topic_id, issue: p.issue_id, source_form: p.source_form, publication_kind: p.publication_kind };
    for (const [key, value] of Object.entries(dimensions)) (grouping[`${key}:${value}`] ??= []).push(p);
    (grouping[`stratum:${JSON.stringify(dimensions)}`] ??= []).push(p);
  }
  const count = (status: string) => input.attempts.filter((a) => a.status === status).length;
  const completion = Object.fromEntries(CLOCKS.map((k) => [k, {
    denominator: input.observations.length, recorded: input.observations.filter((o) => o.clocks[k].value !== null).length,
    unknown: input.observations.filter((o) => o.clocks[k].value === null).length,
  }]));
  const stageDelays = Object.fromEntries(SEGMENTS.map(([from, to]) => [`${from}->${to}`,
    distribution(input.observations.map((o) => durationHours(o.clocks[from], o.clocks[to])))]));
  const stageLoss = Object.fromEntries(SEGMENTS.map(([from, to]) => {
    const entered = input.observations.filter((o) => o.clocks[from].value !== null);
    const missing = entered.filter((o) => o.clocks[to].value === null);
    return [`${from}->${to}`, { entered_recorded: entered.length,
      progressed_recorded: entered.length - missing.length,
      terminal_loss_recorded: missing.filter((o) => isProvedStageLoss(o, from, to)).length,
      pending_or_unobserved: missing.filter((o) => !isProvedStageLoss(o, from, to)).length,
      entry_unknown: input.observations.length - entered.length }];
  }));
  const observationGroups: Record<string, FreshnessInput["observations"]> = { all: input.observations };
  for (const a of input.attempts) { observationGroups[`topic:${a.topic_id}`] ??= []; observationGroups[`issue:${a.issue_id}`] ??= []; }
  for (const o of input.observations) {
    const dimensions = { topic: o.topic_id, issue: o.issue_id, source_form: o.source_form, publication_kind: o.publication_kind };
    for (const [key, value] of Object.entries(dimensions)) (observationGroups[`${key}:${value}`] ??= []).push(o);
    (observationGroups[`stratum:${JSON.stringify(dimensions)}`] ??= []).push(o);
  }
  return { format_version: "rich-brief-freshness-summary-v1", mode: input.mode, as_of: input.as_of, window: input.window,
    provenance: input.provenance, comparison: input.comparison,
    comparison_ready: false, // Pair/cost/gold/independent review gates live outside a single-arm diagnostic.
    comparison_metadata_complete: input.comparison.complete_source_pool && input.comparison.complete_source_pool_sha256 !== null
      && input.comparison.model !== null && input.comparison.token_budget !== null && input.comparison.usd_budget !== null && input.comparison.paired_run_id !== null,
    units: { age: "published_message_primary_evidence_clock", stage: "input_source_revision_per_analysis_attempt", percentile: "nearest_rank", threshold: "inclusive_24h_48h", attempt: "all_observed_analysis_attempts_not_source_acquisition_attempts" },
    attempts: { total: input.attempts.length, completed: count("completed"), failed: count("failed"), unknown: count("unknown"),
      without_inputs: input.attempts.filter((a) => a.input_source_revisions.length === 0).length,
      cost_unknown: input.attempts.filter((a) => a.ledger.usd === null).length,
      observed_usd_lower_bound: input.attempts.reduce((n, a) => n + (a.ledger.usd ?? 0), 0) },
    analyze_execution_delay: distribution(input.attempts.map((a) => durationHours(a.analyzer_started, a.analyzer_completed))),
    clock_completion: completion, stage_delays: stageDelays, stage_loss: stageLoss,
    stage_delays_by_stratum: Object.fromEntries(Object.entries(observationGroups).map(([key, observations]) => [key,
      Object.fromEntries(SEGMENTS.map(([from, to]) => [`${from}->${to}`, distribution(observations.map((o) => durationHours(o.clocks[from], o.clocks[to])))]))])),
    candidate_terminal_counts: input.candidate_terminal_counts,
    by_stratum: Object.fromEntries(Object.entries(grouping).map(([key, rows]) => [key, publicationMetrics(rows, input.reader_scenario_at)])) };
}

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const array = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : [];
const parseJSON = (v: unknown): Row => { try { return obj(JSON.parse(String(v))); } catch { return {}; } };
const parseArray = (v: unknown): Row[] => { try { return array(JSON.parse(String(v))); } catch { return []; } };
const referenceId = (s: Row): string | null => typeof obj(obj(s.ref).locator).id === "string" ? String(obj(obj(s.ref).locator).id) : null;
const revisionId = (s: Row): string => `${referenceId(s) ?? "unknown"}:${obj(s.ref).revision ?? "unknown"}`;

/** Reads only an already sealed S0 JSON export; never opens any DB or reads source bodies into output. */
export function fromDensityExport(exportDir: string): FreshnessInput {
  if (!isAbsolute(exportDir)) throw new Error("absolute_export_path_required");
  for (const name of ["snapshot-manifest.json", "candidate-pool.jsonl"]) if (lstatSync(join(exportDir, name)).isSymbolicLink()) throw new Error("symlink_input_forbidden");
  const manifestBytes = readFileSync(join(exportDir, "snapshot-manifest.json"));
  const manifest = obj(JSON.parse(manifestBytes.toString("utf8")));
  const poolBytes = readFileSync(join(exportDir, "candidate-pool.jsonl"));
  if (obj(manifest.artifact_hashes)["candidate-pool.jsonl"] !== hash(poolBytes)) throw new Error("export_pool_hash_mismatch");
  const records = poolBytes.toString("utf8").split("\n").filter(Boolean).map((line) => obj(JSON.parse(line)));
  const input: FreshnessInput = {
    format_version: "rich-brief-freshness-v1", mode: "historical_exploratory", as_of: String(manifest.as_of),
    window: obj(manifest.window) as FreshnessInput["window"],
    provenance: { input_sha256: hash(manifestBytes), resource_version: String(manifest.format_version),
      scope: "sealed_s0_export_all_batch_and_observed_analyze_attempts", gaps: ["complete_source_pool_not_exported", "source_acquisition_failures_not_exported", "first_available_unknown", "first_collected_unknown", "selected_timestamp_unknown", "evidence_pass_timestamp_unknown", "source_version_update_unknown", "publication_commit_timestamp_unknown_generated_at_proxy", "first_vs_followup_requires_human_history_labels", "reader_open_telemetry_unknown"] },
    comparison: { arm: "historical_diagnostic", complete_source_pool_sha256: null, complete_source_pool: false, model: null, token_budget: null, usd_budget: null, paired_run_id: null },
    reader_scenario_at: null, attempts: [], observations: [], publications: [], candidate_terminal_counts: {},
  };
  const seenPublications = new Set<string>();
  for (const [recordIndex, record] of records.entries()) {
    const batch = obj(record.batch), sources = array(record.input_evidence), candidates = array(record.candidates), reviews = array(record.report_reviews);
    const topic = String(batch.topic_id ?? record.topic_id ?? "unknown");
    const issue = String(reviews[0]?.report_id ?? `unpublished:${batch.id ?? obj(record.started).trace_id ?? recordIndex}`);
    const links = record.kind === "trace_without_batch" ? [{ started: record.started, completed: null }] : array(record.analysis_links);
    const effectiveLinks = links.length ? links : [{ started: null, completed: null }];
    for (const [linkIndex, link] of effectiveLinks.entries()) {
      const started = obj(link.started), completed = obj(link.completed);
      const attemptId = `${started.trace_id ?? completed.trace_id ?? batch.id ?? `record${recordIndex}`}:${started.attempt ?? completed.attempt ?? linkIndex}`;
      const terminalEvents = array(record.terminal_events);
      const failed = terminalEvents.some((e) => e.event_type === "failed");
      const context = parseJSON(started.version_context);
      const linkedRefs = parseArray(started.input_refs).filter((r) => r.type === "content_item");
      const linkedSources = linkedRefs.length ? sources.filter((s) => linkedRefs.some((r) =>
        r.revision === obj(s.ref).revision && obj(r.locator).id === referenceId(s))) : [];
      input.attempts.push({ attempt_id: attemptId, topic_id: topic, issue_id: issue,
        status: completed.event_type === "completed" ? "completed" : failed ? "failed" : "unknown",
        input_source_revisions: linkedSources.map(revisionId),
        analyzer_started: recordedClock(started.occurred_at, "generation_event", `generation_event:${started.id}`),
        analyzer_completed: recordedClock(completed.occurred_at, "generation_event", `generation_event:${completed.id}`),
        ledger: { model: typeof context.analyzer_model === "string" ? context.analyzer_model : null,
          input_tokens: null, output_tokens: null, usd: null, failure_code: failed ? String(terminalEvents.find((e) => e.event_type === "failed")?.reason_code ?? "analysis_failed") : null } });
      for (const source of linkedSources) {
        const snapshot = obj(source.snapshot), clocks = unknownClocks();
        clocks.source_published = recordedClock(snapshot.published_at, "source_metadata", `source_revision:${revisionId(source)}:published_at`);
        clocks.extracted = recordedClock(completed.occurred_at, "generation_event", `generation_event:${completed.id}`);
        const sourceId = referenceId(source);
        const associated = candidates.filter((c) => array(c.citations).some((ci) => ci.content_item_id === sourceId));
        const publications = associated.flatMap((c) => array(c.report_outcomes)).filter((r) => r.terminal === "published");
        // S0 generated_at is report creation time, not observed commit time: leave publication clock unknown in stage delays.
        input.observations.push({ observation_id: `${attemptId}:${revisionId(source)}`, attempt_id: attemptId,
          source_revision: revisionId(source), source_family: null, topic_id: topic, issue_id: issue,
          source_form: snapshot.body_kind === "show_notes" ? "show_notes" : snapshot.body_kind === "transcript" ? "transcript" : "unknown",
          publication_kind: "unknown", clocks, terminal: publications.length ? "published" : "unknown" });
      }
    }
    for (const candidate of candidates) {
      const terminal = String(candidate.terminal ?? "unknown");
      input.candidate_terminal_counts[terminal] = (input.candidate_terminal_counts[terminal] ?? 0) + 1;
      const insight = obj(candidate.insight);
      for (const outcome of array(candidate.report_outcomes).filter((r) => r.terminal === "published")) {
        const publicationId = `${outcome.report_id}:${insight.id}`;
        if (seenPublications.has(publicationId)) continue;
        seenPublications.add(publicationId);
        // Production statement_citation_index is 1-based; persisted citation.citation_index is 0-based.
        const citation = typeof insight.statement_citation_index === "number"
          ? array(candidate.citations).find((c) => c.citation_index === Number(insight.statement_citation_index) - 1) : undefined;
        const primary = citation ? sources.filter((s) => referenceId(s) === citation.content_item_id) : [];
        const source = primary.length === 1 ? primary[0] : null, snapshot = obj(source?.snapshot), clocks = unknownClocks();
        if (source) clocks.source_published = recordedClock(snapshot.published_at, "source_metadata", `source_revision:${revisionId(source)}:published_at`);
        // Historical explorer deliberately labels the proxy in evidence_ref and provenance; not a certified publication clock.
        clocks.published = recordedClock(outcome.generated_at, "generation_event", `report_generated_at_proxy:${outcome.report_id}`);
        input.publications.push({ publication_id: publicationId, attempt_id: null, topic_id: topic, issue_id: String(outcome.report_id),
          source_form: snapshot.body_kind === "show_notes" ? "show_notes" : snapshot.body_kind === "transcript" ? "transcript" : "unknown",
          publication_kind: "unknown", event_id: typeof insight.event_id === "string" ? insight.event_id : null,
          proposition_id: null, primary_source_revision: source ? revisionId(source) : null, clocks });
      }
    }
  }
  return freshnessInputSchema.parse(input);
}

export function prospectiveTemplate(asOf: string, from: string, until: string): FreshnessInput {
  return freshnessInputSchema.parse({ format_version: "rich-brief-freshness-v1", mode: "prospective_observation", as_of: asOf,
    window: { from_inclusive: from, until_exclusive: until },
    provenance: { input_sha256: null, resource_version: "rich-brief-freshness-v1", scope: "template_not_observed", gaps: ["observation_not_started"] },
    comparison: { arm: "F0", complete_source_pool_sha256: null, complete_source_pool: false, model: null, token_budget: null, usd_budget: null, paired_run_id: null },
    reader_scenario_at: null, attempts: [], observations: [], publications: [], candidate_terminal_counts: {} });
}

export function writePrivateResult(outputDir: string, input: FreshnessInput): void {
  if (!isAbsolute(outputDir) || existsSync(outputDir)) throw new Error("new_absolute_output_required");
  const parent = realpathSync(dirname(outputDir));
  let root = parent;
  while (!existsSync(join(root, ".git")) && dirname(root) !== root) root = dirname(root);
  if (existsSync(join(root, ".git"))) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    if (spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", join(parent, basename(outputDir))], { env }).status !== 0)
      throw new Error("output_must_be_gitignored");
  }
  const validated = freshnessInputSchema.parse(input), summary = summarizeFreshness(validated);
  mkdirSync(outputDir, { mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  save("observations.json", validated); save("summary.json", summary);
  save("manifest.json", { format_version: "rich-brief-freshness-artifacts-v1", observations_sha256: hash(readFileSync(join(outputDir, "observations.json"))), summary_sha256: hash(readFileSync(join(outputDir, "summary.json"))), implementation_sha256: hash(readFileSync(new URL(import.meta.url))) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, inputPath, output, from, until] = process.argv.slice(2);
  let input: FreshnessInput;
  if (command === "from-export" && inputPath && output) input = fromDensityExport(inputPath);
  else if (command === "summarize" && inputPath && output) input = freshnessInputSchema.parse(JSON.parse(readFileSync(inputPath, "utf8")));
  else if (command === "template" && inputPath && output && from && until) input = prospectiveTemplate(inputPath, from, until);
  else throw new Error("Usage: tsx evals/rich-brief-stage0/freshness.ts from-export /abs/sealed-export /abs/new-output | summarize /abs/observations.json /abs/new-output | template as-of-utc /abs/new-output from-utc until-utc");
  writePrivateResult(output, input);
  console.log(JSON.stringify({ attempts: input.attempts.length, observations: input.observations.length, publications: input.publications.length, mode: input.mode }));
}
