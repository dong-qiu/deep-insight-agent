/** Exploration-only immutable clock receipts. No DB, source fetch, model, or formal holdout. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { freshnessInputSchema, summarizeFreshness, unknownClock, unknownClocks, type FreshnessInput } from "./freshness";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, "four-digit-year canonical UTC required");
const sourceSchema = z.object({ source_id: id, revision: id, body_sha256: sha }).strict();
const registeredSourceSchema = sourceSchema.extend({
  topic_id: id, issue_id: id, source_form: z.enum(["article", "paper_abstract", "paper_fulltext", "show_notes", "transcript", "mixed", "unknown"]), source_family: id.nullable(),
}).strict();
export const forwardJournalConfigSchema = z.object({
  format_version: z.literal("forward-clock-journal-v1"), journal_id: id, run_id: id,
  scope: z.literal("exploration"), sources: z.array(registeredSourceSchema),
}).strict().superRefine((v, ctx) => {
  const keys = v.sources.map(sourceKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "duplicate source identity" });
});
const resourceSchema = z.object({ path: id, sha256: sha, role: z.enum(["receipt", "source_body", "publication_commit", "metadata"]) }).strict();
const ledgerSchema = z.object({
  model: id.nullable(), input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(),
  usd: z.number().nonnegative().nullable(), failure_code: id.nullable(),
}).strict();
const baseEvent = z.object({ event_id: id, run_id: id, attempt_id: id,
  attempt_kind: z.enum(["source_acquisition", "analysis"]), source: sourceSchema,
  observed_at: utc, resources: z.array(resourceSchema).min(1),
});
export const forwardEventSchema = z.discriminatedUnion("kind", [
  baseEvent.extend({ kind: z.literal("availability_observed"), result: z.enum(["available", "unavailable", "unknown"]), reason: id }).strict(),
  baseEvent.extend({ kind: z.literal("collected") }).strict(),
  baseEvent.extend({ kind: z.literal("selected") }).strict(),
  baseEvent.extend({ kind: z.literal("extracted") }).strict(),
  baseEvent.extend({ kind: z.literal("evidence_pass") }).strict(),
  baseEvent.extend({ kind: z.literal("publication_committed"), publication_id: id }).strict(),
  baseEvent.extend({ kind: z.literal("source_clock"), name: z.enum(["event_at", "recorded_at", "source_published", "source_version_updated"]), value: utc }).strict(),
  baseEvent.extend({ kind: z.literal("stage_failed"), stage: z.enum(["collection", "selection", "extraction", "evidence", "publication"]), reason: id }).strict(),
  baseEvent.extend({ kind: z.literal("attempt_started") }).strict(),
  baseEvent.extend({ kind: z.literal("attempt_finished"), status: z.enum(["completed", "failed", "unknown"]), ledger: ledgerSchema }).strict(),
]);
const envelopeSchema = z.object({ seq: z.number().int().positive(), config_sha256: sha,
  previous_sha256: sha.nullable(), recorded_at: utc, event: forwardEventSchema, entry_sha256: sha }).strict();
const commitSchema = z.object({ format_version: z.literal("forward-publication-commit-v1"), run_id: id, attempt_id: id,
  source: sourceSchema, publication_id: id, committed_at: utc, artifact_resource: z.object({ path: id, sha256: sha }).strict() }).strict();
const positiveSchema = z.object({ format_version: z.literal("forward-positive-observation-v1"), run_id: id, attempt_id: id,
  source: sourceSchema, observed_at: utc, http_status: z.literal(200), source_body: z.object({ path: id, sha256: sha }).strict() }).strict();
export type ForwardJournalConfig = z.infer<typeof forwardJournalConfigSchema>;
export type ForwardEvent = z.infer<typeof forwardEventSchema>;
export type ForwardEnvelope = z.infer<typeof envelopeSchema>;
export type ForwardJournal = Readonly<{ config: ForwardJournalConfig; config_sha256: string; entries: readonly ForwardEnvelope[] }>;
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function sourceKey(s: z.infer<typeof sourceSchema>): string { return JSON.stringify([s.source_id, s.revision]); }
const filename = (seq: number) => `${String(seq).padStart(10, "0")}.json`;
const clock = (e: ForwardEvent, basis: "observer" | "generation_event" | "artifact_commit" | "source_metadata" = "observer", value = e.observed_at) => ({ value, basis, evidence_ref: `forward-event:${e.event_id}`, unknown_reason: null });
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const child of Object.values(v)) freeze(child); }
  return v;
}
function canonicalExisting(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) throw new Error("canonical_non_symlink_path_required");
}
function resourceBytes(r: z.infer<typeof resourceSchema>): Buffer {
  canonicalExisting(r.path);
  if (!lstatSync(r.path).isFile()) throw new Error("resource_must_be_file");
  const b = readFileSync(r.path);
  if (hash(b) !== r.sha256) throw new Error("evidence_resource_hash_drift");
  return b;
}
function assertPrivate(path: string, mode: number): void {
  if ((lstatSync(path).mode & 0o777) !== mode) throw new Error("private_permissions_required");
}
function assertIgnored(directory: string): void {
  let root = dirname(directory);
  while (!existsSync(join(root, ".git")) && dirname(root) !== root) root = dirname(root);
  if (!existsSync(join(root, ".git"))) return;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  if (spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", directory], { env }).status !== 0) throw new Error("journal_must_be_gitignored");
}
function entryPayload(entry: ForwardEnvelope) {
  return { seq: entry.seq, config_sha256: entry.config_sha256, previous_sha256: entry.previous_sha256, recorded_at: entry.recorded_at, event: entry.event };
}
function validateJournal(journal: ForwardJournal): void {
  const config = forwardJournalConfigSchema.parse(journal.config), sources = new Map(config.sources.map((s) => [sourceKey(s), s]));
  if (hash(JSON.stringify(config, null, 2) + "\n") !== journal.config_sha256) throw new Error("journal_config_drift");
  const publicationIds = new Set<string>();
  const ids = new Set<string>(), resources = new Map<string, string>(), sourceClocks = new Set<string>(), collected = new Set<string>();
  const attempts = new Map<string, { kind: ForwardEvent["attempt_kind"]; topic: string; issue: string; started: boolean; finished: boolean; failed: boolean }>();
  const stages = new Map<string, Set<string>>(), failedSources = new Set<string>();
  let previous: ForwardEnvelope | undefined;
  for (const [index, raw] of journal.entries.entries()) {
    const entry = envelopeSchema.parse(raw), event = entry.event, registered = sources.get(sourceKey(event.source));
    if (entry.seq !== index + 1 || entry.config_sha256 !== journal.config_sha256 || entry.previous_sha256 !== (previous?.entry_sha256 ?? null)
      || entry.entry_sha256 !== hash(JSON.stringify(entryPayload(entry)))) throw new Error("journal_chain_drift");
    if (ids.has(event.event_id)) throw new Error("duplicate_event_id");
    ids.add(event.event_id);
    if (!registered || registered.body_sha256 !== event.source.body_sha256) throw new Error("source_version_or_body_drift");
    if (event.run_id !== config.run_id) throw new Error("run_binding_mismatch");
    if (event.observed_at > entry.recorded_at || entry.recorded_at > new Date().toISOString()) throw new Error("future_observation_or_recording");
    if (previous && (event.observed_at < previous.event.observed_at || entry.recorded_at < previous.recorded_at)) throw new Error("observation_order_rejected");
    for (const resource of event.resources) {
      const previousHash = resources.get(resource.path);
      if (previousHash !== undefined && previousHash !== resource.sha256) throw new Error("resource_identity_drift");
      resources.set(resource.path, resource.sha256); resourceBytes(resource);
    }
    const attempt = attempts.get(event.attempt_id) ?? { kind: event.attempt_kind, topic: registered.topic_id, issue: registered.issue_id, started: false, finished: false, failed: false };
    if (attempt.kind !== event.attempt_kind || attempt.topic !== registered.topic_id || attempt.issue !== registered.issue_id) throw new Error("attempt_binding_drift");
    if (attempt.finished) throw new Error("attempt_already_finished");
    const key = JSON.stringify([event.attempt_id, sourceKey(event.source)]), done = stages.get(key) ?? new Set<string>();
    if ((["selected", "extracted", "evidence_pass", "publication_committed"].includes(event.kind) || (event.kind === "stage_failed" && event.stage !== "collection")) && event.attempt_kind !== "analysis") throw new Error("analysis_stage_requires_analysis_attempt");
    if (failedSources.has(key) && !["attempt_finished", "source_clock"].includes(event.kind)) throw new Error("failed_source_requires_new_attempt");
    if (event.kind === "attempt_started") {
      if (attempt.started || journal.entries.slice(0, index).some((e) => e.event.attempt_id === event.attempt_id)) throw new Error("duplicate_or_late_attempt_start");
      attempt.started = true;
    } else if (event.kind === "attempt_finished") {
      if (attempt.failed && event.status === "completed") throw new Error("failed_attempt_cannot_complete");
      if (event.status === "completed" && event.ledger.failure_code !== null) throw new Error("completed_attempt_failure_code");
      attempt.finished = true;
    } else if (event.kind === "source_clock") {
      const name = JSON.stringify([sourceKey(event.source), event.name]);
      if (sourceClocks.has(name)) throw new Error("duplicate_source_clock");
      if (event.value > event.observed_at || !event.resources.some((r) => r.role === "metadata")) throw new Error("invalid_source_clock_evidence");
      sourceClocks.add(name);
    } else if (event.kind === "stage_failed") {
      const needs: Record<typeof event.stage, string | null> = { collection: null, selection: null, extraction: "selected", evidence: "extracted", publication: "evidence_pass" };
      const completed: Record<typeof event.stage, string> = { collection: "collected", selection: "selected", extraction: "extracted", evidence: "evidence_pass", publication: "publication_committed" };
      if (done.has(completed[event.stage]) || (needs[event.stage] && !done.has(needs[event.stage]!))) throw new Error("failure_stage_order_rejected");
      if (event.stage === "selection" && !collected.has(sourceKey(event.source))) throw new Error("selection_requires_collection");
      failedSources.add(key); attempt.failed = true;
    } else {
      if (done.has(event.kind)) throw new Error("duplicate_stage");
      if (event.kind === "availability_observed" && event.result === "unavailable") {
        const proofs = event.resources.filter((r) => r.role === "receipt").map((r) => { try { return JSON.parse(resourceBytes(r).toString("utf8")) as Record<string, unknown>; } catch { return null; } });
        if (!proofs.some((p) => p?.format_version === "forward-negative-observation-v1" && p.run_id === event.run_id && p.attempt_id === event.attempt_id
          && p.observed_at === event.observed_at && p.reason === event.reason && JSON.stringify(p.source) === JSON.stringify(event.source)
          && (p.http_status === 404 || p.http_status === 410 || p.publisher_state === "not_yet_published"))) throw new Error("confirmed_negative_receipt_required");
      }
      if (event.kind === "availability_observed" && event.result === "available") {
        const proofs = event.resources.filter((r) => r.role === "receipt").flatMap((r) => {
          try { const parsed = positiveSchema.safeParse(JSON.parse(resourceBytes(r).toString("utf8"))); return parsed.success ? [parsed.data] : []; } catch { return []; }
        });
        if (!proofs.some((p) => p.run_id === event.run_id && p.attempt_id === event.attempt_id && p.observed_at === event.observed_at
          && JSON.stringify(p.source) === JSON.stringify(event.source) && p.source_body.sha256 === event.source.body_sha256
          && event.resources.some((r) => r.role === "source_body" && r.path === p.source_body.path && r.sha256 === p.source_body.sha256))) throw new Error("confirmed_positive_receipt_required");
      }
      if (event.kind === "collected") {
        if (["selected", "extracted", "evidence_pass", "publication_committed"].some((k) => done.has(k))) throw new Error("collection_stage_order_rejected");
        if (!event.resources.some((r) => r.role === "source_body" && r.sha256 === event.source.body_sha256)) throw new Error("collection_body_evidence_required");
        collected.add(sourceKey(event.source));
      } else if (event.kind === "selected") {
        if (!collected.has(sourceKey(event.source))) throw new Error("selection_requires_collection");
      } else if (event.kind === "extracted" && !done.has("selected")) throw new Error("extraction_requires_selection");
      else if (event.kind === "evidence_pass" && !done.has("extracted")) throw new Error("evidence_requires_extraction");
      else if (event.kind === "publication_committed") {
        if (!done.has("evidence_pass")) throw new Error("publication_requires_evidence_pass");
        if (publicationIds.has(event.publication_id)) throw new Error("duplicate_publication_id");
        publicationIds.add(event.publication_id);
        const proofs = event.resources.filter((r) => r.role === "publication_commit");
        if (proofs.length !== 1) throw new Error("publication_commit_receipt_required");
        const proof = commitSchema.parse(JSON.parse(resourceBytes(proofs[0]).toString("utf8")));
        if (!event.resources.some((r) => r.path === proof.artifact_resource.path && r.sha256 === proof.artifact_resource.sha256 && r.role === "receipt")) throw new Error("publication_artifact_resource_required");
        resourceBytes({ ...proof.artifact_resource, role: "receipt" });
        if (proof.run_id !== event.run_id || proof.attempt_id !== event.attempt_id || proof.publication_id !== event.publication_id
          || proof.committed_at !== event.observed_at || JSON.stringify(proof.source) !== JSON.stringify(event.source)) throw new Error("publication_commit_binding_mismatch");
      }
      done.add(event.kind);
    }
    stages.set(key, done); attempts.set(event.attempt_id, attempt); previous = entry;
  }
}
export function createForwardJournal(directory: string, rawConfig: unknown): ForwardJournal {
  if (!isAbsolute(directory) || resolve(directory) !== directory || existsSync(directory)) throw new Error("new_absolute_journal_required");
  canonicalExisting(dirname(directory)); assertIgnored(directory);
  const config = forwardJournalConfigSchema.parse(rawConfig), bytes = JSON.stringify(config, null, 2) + "\n";
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "config.json"), bytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(directory, "config.sha256"), hash(bytes) + "\n", { mode: 0o600, flag: "wx" });
  return readForwardJournal(directory);
}
export function readForwardJournal(directory: string): ForwardJournal {
  canonicalExisting(directory); assertPrivate(directory, 0o700);
  const configPath = join(directory, "config.json"), hashPath = join(directory, "config.sha256");
  canonicalExisting(configPath); canonicalExisting(hashPath); assertPrivate(configPath, 0o600); assertPrivate(hashPath, 0o600);
  const bytes = readFileSync(configPath), configSha = readFileSync(hashPath, "utf8").trim();
  if (configSha !== hash(bytes)) throw new Error("journal_config_drift");
  const names = readdirSync(directory).filter((n) => !["config.json", "config.sha256"].includes(n)).sort();
  if (names.some((n) => !/^\d{10}\.json$/.test(n))) throw new Error("unexpected_journal_entry");
  const entries = names.map((n, i) => {
    if (n !== filename(i + 1)) throw new Error("journal_sequence_gap");
    const path = join(directory, n); canonicalExisting(path); assertPrivate(path, 0o600);
    return envelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  });
  const journal = { config: forwardJournalConfigSchema.parse(JSON.parse(bytes.toString("utf8"))), config_sha256: configSha, entries };
  validateJournal(journal); return freeze(journal);
}
export function appendForwardEvent(directory: string, rawEvent: unknown, recordedAt = new Date().toISOString()): ForwardEnvelope {
  const journal = readForwardJournal(directory), event = forwardEventSchema.parse(rawEvent);
  const payload = { seq: journal.entries.length + 1, config_sha256: journal.config_sha256,
    previous_sha256: journal.entries.at(-1)?.entry_sha256 ?? null, recorded_at: utc.parse(recordedAt), event };
  const entry = { ...payload, entry_sha256: hash(JSON.stringify(payload)) };
  validateJournal({ ...journal, entries: [...journal.entries, entry] });
  // O_EXCL means a competing writer cannot silently replace this sequence.
  writeFileSync(join(directory, filename(entry.seq)), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return freeze(entry);
}
function distribution(values: (number | null)[]) {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { total: values.length, known: known.length, unknown: values.length - known.length,
    p50_hours: known.length ? known[Math.ceil(.5 * known.length) - 1] : null,
    p90_hours: known.length ? known[Math.ceil(.9 * known.length) - 1] : null };
}
const elapsed = (start: ForwardEvent | undefined, end: ForwardEvent | undefined) => start && end
  ? (Date.parse(end.observed_at) - Date.parse(start.observed_at)) / 3_600_000 : null;
/** Hash-verified exploration output. Lifetime first clocks are deliberately not certified. */
export function assembleForwardClocks(journal: ForwardJournal, asOf: string, window: FreshnessInput["window"]) {
  validateJournal(journal); utc.parse(asOf); utc.parse(window.from_inclusive); utc.parse(window.until_exclusive);
  if (journal.entries.some((e) => e.event.observed_at > asOf || e.recorded_at > asOf)) throw new Error("journal_beyond_as_of");
  const events = journal.entries.map((e) => e.event), config = journal.config;
  if (events.some((e) => e.observed_at < window.from_inclusive || e.observed_at >= window.until_exclusive)) throw new Error("journal_observations_outside_window");
  const input: FreshnessInput = { format_version: "rich-brief-freshness-v1", mode: "prospective_observation", as_of: asOf, window,
    provenance: { input_sha256: journal.entries.at(-1)?.entry_sha256 ?? journal.config_sha256, resource_version: "forward-clock-journal-v1",
      scope: "exploration_observed_receipts_not_formal_holdout", gaps: ["first_available_exact_unknown", "first_collected_lifetime_unknown", "complete_source_pool_not_certified", "publication_kind_requires_history_evidence", "reader_open_telemetry_unknown"] },
    comparison: { arm: "F_exploration_receipts", complete_source_pool_sha256: null, complete_source_pool: false,
      model: null, token_budget: null, usd_budget: null, paired_run_id: null },
    reader_scenario_at: null, attempts: [], observations: [], publications: [], candidate_terminal_counts: {} };
  const availability = config.sources.map((source) => {
    const observations = events.filter((e): e is Extract<ForwardEvent, { kind: "availability_observed" }> => e.kind === "availability_observed" && sourceKey(e.source) === sourceKey(source));
    const first = observations.find((e) => e.result === "available"), negative = observations.filter((e) => e.result === "unavailable" && (!first || e.observed_at < first.observed_at)).at(-1);
    return { source: { source_id: source.source_id, revision: source.revision, body_sha256: source.body_sha256 },
      first_observed_available: first ? clock(first) : unknownClock("successful_availability_not_observed"),
      last_negative_before_first_observed: negative ? clock(negative) : unknownClock("confirmed_negative_not_observed"),
      availability_interval: first ? { lower_exclusive: negative?.observed_at ?? null, upper_inclusive: first.observed_at, exact_first_available_certified: false } : null };
  });
  const attempts = [...new Set(events.map((e) => e.attempt_id))].map((attemptId) => {
    const rows = events.filter((e) => e.attempt_id === attemptId), start = rows.find((e) => e.kind === "attempt_started");
    const finish = rows.find((e): e is Extract<ForwardEvent, { kind: "attempt_finished" }> => e.kind === "attempt_finished");
    const targets = [...new Set(rows.map((e) => sourceKey(e.source)))], firstSource = config.sources.find((s) => sourceKey(s) === targets[0])!;
    const status = finish?.status ?? (rows.some((e) => e.kind === "stage_failed") ? "failed" : "unknown");
    return { attempt_id: attemptId, kind: rows[0].attempt_kind, topic_id: firstSource.topic_id, issue_id: firstSource.issue_id, targets, rows, start, finish, status,
      ledger: finish?.ledger ?? { model: null, input_tokens: null, output_tokens: null, usd: null, failure_code: null } };
  });
  const stageRows: { attempt_id: string; source_revision: string; collection?: ForwardEvent; selection?: ForwardEvent; extraction?: ForwardEvent; evidence?: ForwardEvent; publication?: ForwardEvent; failed_stage: string | null }[] = [];
  for (const a of attempts.filter((a) => a.kind === "analysis")) {
    const active = a.targets.filter((key) => a.rows.some((e) => sourceKey(e.source) === key && ["collected", "selected", "extracted", "evidence_pass", "publication_committed", "stage_failed"].includes(e.kind)));
    const extracted = a.rows.filter((e) => e.kind === "extracted").at(-1);
    input.attempts.push({ attempt_id: a.attempt_id, topic_id: a.topic_id, issue_id: a.issue_id,
      status: a.status as "completed" | "failed" | "unknown", input_source_revisions: active,
      analyzer_started: a.start ? clock(a.start, "generation_event") : unknownClock("analysis_start_not_observed"),
      analyzer_completed: extracted && active.every((key) => a.rows.some((e) => sourceKey(e.source) === key && e.kind === "extracted"))
        ? clock(extracted, "generation_event") : unknownClock("extraction_completion_not_observed"), ledger: a.ledger });
    for (const key of active) {
      const source = config.sources.find((s) => sourceKey(s) === key)!, rows = a.rows.filter((e) => sourceKey(e.source) === key), find = (kind: ForwardEvent["kind"]) => rows.find((e) => e.kind === kind);
      const selected = find("selected"), extracted = find("extracted"), pass = find("evidence_pass"), publication = find("publication_committed");
      const fail = rows.find((e): e is Extract<ForwardEvent, { kind: "stage_failed" }> => e.kind === "stage_failed");
      const boundary = selected ?? fail ?? rows[0];
      const collected = events.slice(0, events.indexOf(boundary)).filter((e) => sourceKey(e.source) === key && e.kind === "collected").at(-1);
      const clocks = unknownClocks(); clocks.first_available = unknownClock("first_observed_available_is_not_exact_first_available"); clocks.first_collected = unknownClock("lifetime_first_collection_history_not_proved");
      for (const e of events.filter((e): e is Extract<ForwardEvent, { kind: "source_clock" }> => e.kind === "source_clock" && sourceKey(e.source) === key)) clocks[e.name] = clock(e, "source_metadata", e.value);
      if (selected) clocks.selected = clock(selected, "generation_event");
      if (extracted) clocks.extracted = clock(extracted, "generation_event");
      if (pass) clocks.evidence_pass = clock(pass, "generation_event");
      if (publication) clocks.published = clock(publication, "artifact_commit");
      const terminal = publication ? "published" : fail?.stage === "selection" ? "not_selected" : fail?.stage === "extraction" ? "extraction_failed" : fail?.stage === "evidence" ? "evidence_rejected" : "unknown";
      input.observations.push({ observation_id: `${a.attempt_id}:${key}`, attempt_id: a.attempt_id, source_revision: key,
        source_family: source.source_family, topic_id: source.topic_id, issue_id: source.issue_id, source_form: source.source_form,
        publication_kind: "unknown", clocks, terminal });
      stageRows.push({ attempt_id: a.attempt_id, source_revision: key, collection: collected, selection: selected, extraction: extracted, evidence: pass, publication, failed_stage: fail?.stage ?? null });
      input.candidate_terminal_counts[terminal] = (input.candidate_terminal_counts[terminal] ?? 0) + 1;
      if (publication?.kind === "publication_committed") input.publications.push({ publication_id: publication.publication_id,
        attempt_id: a.attempt_id, topic_id: source.topic_id, issue_id: source.issue_id, source_form: source.source_form, publication_kind: "unknown",
        event_id: null, proposition_id: null, primary_source_revision: key, clocks: structuredClone(clocks) });
    }
  }
  const observedDelays = { "current_collection->selected": distribution(stageRows.map((r) => elapsed(r.collection, r.selection))),
    "selected->extracted": distribution(stageRows.map((r) => elapsed(r.selection, r.extraction))),
    "extracted->evidence_pass": distribution(stageRows.map((r) => elapsed(r.extraction, r.evidence))),
    "evidence_pass->publication_commit": distribution(stageRows.map((r) => elapsed(r.evidence, r.publication))) };
  const acquisition = attempts.filter((a) => a.kind === "source_acquisition");
  const acquisitionSummary = { denominator: "all_recorded_source_acquisition_attempts", total: acquisition.length,
    completed: acquisition.filter((a) => a.status === "completed").length, failed: acquisition.filter((a) => a.status === "failed").length,
    unknown: acquisition.filter((a) => a.status === "unknown").length, cost_unknown: acquisition.filter((a) => a.ledger.usd === null).length,
    observed_usd_lower_bound: acquisition.reduce((n, a) => n + (a.ledger.usd ?? 0), 0) };
  const failures = events.filter((e): e is Extract<ForwardEvent, { kind: "stage_failed" }> => e.kind === "stage_failed");
  const observedStageFailures = { denominator: "all_recorded_explicit_stage_failure_events", total: failures.length,
    by_stage: Object.fromEntries((["collection", "selection", "extraction", "evidence", "publication"] as const).map((stage) => [stage, failures.filter((e) => e.stage === stage).length])) };
  const validated = freshnessInputSchema.parse(input);
  return freeze({ format_version: "forward-clock-assembly-v1", scope: "exploration", improvement_claim: false, formal_holdout_opened: false,
    source_availability: availability, acquisition_attempts: acquisitionSummary, observed_stage_failures: observedStageFailures,
    current_stage_rows: stageRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === "object" ? clock(v) : v]))),
    observed_stage_delays: observedDelays, input: validated, summary: summarizeFreshness(validated) });
}
