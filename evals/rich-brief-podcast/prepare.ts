/** Metadata-only C preparation. Does not open SQLite, fetch sources, invoke models, or read holdout. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { stableEvidenceUrl } from "../../src/lib/sources/podcast-evidence.js";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const text = z.string().min(1), sha = z.string().regex(/^[a-f0-9]{64}$/);
const utc = z.string().refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const occurrenceSchema = z.object({
  occurrence_id: text, run_id: text, attempt_id: text, source_key: text,
  ref: z.object({ type: z.literal("content_item"), role: z.literal("input"), locator: z.object({ kind: z.literal("id"), id: text }).strict(), revision: z.string().regex(/^content-v4:[a-f0-9]{64}$/) }).strict(),
  body: z.string().nullable(), body_sha256: sha.nullable(), body_kind: z.enum(["article", "show_notes", "transcript", "unknown"]),
  url: text, family_component: text.nullable(), evidence_gaps: z.array(text), partition: z.enum(["exploration", "unknown"]),
}).passthrough();
const worklistSchema = z.object({
  schema_version: z.literal("rich-brief-stage0-input-v1"), topic: z.literal("t_code_agents"),
  exposure: z.object({ formal_holdout: z.literal(0), semantic_family_completeness: z.literal("unknown") }).passthrough(),
  runs: z.array(z.object({ run_id: text, scheduled_at: utc, status: z.enum(["observed", "unknown"]), attempt_ids: z.array(text) }).strict()),
  attempts: z.array(z.object({ attempt_id: text, run_id: text, kind: text, total_candidates: z.union([z.number().int().nonnegative(), z.literal("unknown")]) }).passthrough()),
  occurrences: z.array(occurrenceSchema),
}).passthrough();
const unknown = (reason: string) => ({ status: "unknown" as const, reason });
export const REQUIRED_C_CASES = ["host_question_as_guest_view", "host_summary_as_guest_view", "cross_segment_fake_quote", "unknown_map_named_attribution", "verified_map_missing_segment", "wrong_speaker_or_role", "episode_pair_mismatch", "version_or_locator_mismatch", "source_view_missing_argument_or_qualifier", "valid_unattributed_transcript", "valid_guest_view_with_verified_map"] as const;

/** Future scoring ledger; no AI self-gold and no missing failed-attempt costs silently counted as zero. */
export const podcastEvaluationLedgerSchema = z.object({
  schema_version: z.literal("rich-brief-podcast-evaluation-ledger-v1"),
  dataset_id: text, execution_scope: z.enum(["exploration_shadow", "synthetic_test"]), resource_version: text,
  attempts: z.array(z.object({
    attempt_id: text, arm: z.enum(["show_notes", "transcript"]), episode_pair_id: text.nullable(),
    source_revision: text, case_kind: z.enum(REQUIRED_C_CASES), speaker_stratum: z.enum(["verified", "unknown", "not_applicable"]),
    human_gold: z.object({ status: z.enum(["pending", "confirmed"]), expected: z.enum(["accept", "reject"]).nullable(), receipt_sha256: sha.nullable() }).strict(),
    result: z.enum(["accepted", "rejected", "failed", "not_run"]), failure_code: text.nullable(),
    model: text.nullable(), prompt_sha256: sha.nullable(), input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(), cost_usd: z.number().nonnegative().nullable(),
    bytes: z.number().int().nonnegative().nullable(), duration_ms: z.number().nonnegative().nullable(),
    evidence: z.object({ canonical_episode_id: text.nullable(), evidence_revision: text.nullable(), speaker_map_sha256: sha.nullable(),
      segments: z.array(z.object({ segment_id: text, speaker_id: text.nullable(), role: z.enum(["host", "guest", "unknown"]),
        char_start: z.number().int().nonnegative(), char_end: z.number().int().positive(), quote_sha256: sha,
        source_locator_ref: text }).strict().refine((s) => s.char_end > s.char_start)),
      view_segment_ids: z.array(text), argument_segment_ids: z.array(text), qualifier_segment_ids: z.array(text),
    }).strict(),
  }).strict()),
}).strict().superRefine((ledger, ctx) => {
  if (new Set(ledger.attempts.map((a) => a.attempt_id)).size !== ledger.attempts.length) ctx.addIssue({ code: "custom", message: "duplicate_attempt" });
  for (const a of ledger.attempts) {
    const gold = a.human_gold;
    if (gold.status === "confirmed" ? gold.expected === null || gold.receipt_sha256 === null : gold.expected !== null || gold.receipt_sha256 !== null)
      ctx.addIssue({ code: "custom", message: "human_gold_receipt_required_or_pending" });
    if ((a.result === "failed") !== (a.failure_code !== null)) ctx.addIssue({ code: "custom", message: "failure_code_result_mismatch" });
    const ids = new Set(a.evidence.segments.map((s) => s.segment_id));
    if (ids.size !== a.evidence.segments.length || [...a.evidence.view_segment_ids, ...a.evidence.argument_segment_ids, ...a.evidence.qualifier_segment_ids].some((id) => !ids.has(id)))
      ctx.addIssue({ code: "custom", message: "segment_binding_missing_or_duplicate" });
    // A verified stratum requires proof material even for adversarial/negative candidates. Other missing-map tests belong to unknown.
    if (a.speaker_stratum === "verified" && a.evidence.speaker_map_sha256 === null)
      ctx.addIssue({ code: "custom", message: "verified_stratum_requires_map_hash" });
  }
});

export function summarizePodcastEvaluation(raw: unknown) {
  const ledger = podcastEvaluationLedgerSchema.parse(raw);
  return { scope: "offline_ledger_only", production_allowed: false, reading_effect: unknown("human_reading_not_evaluated"),
    arms: Object.fromEntries(["show_notes", "transcript"].map((arm) => {
      const rows = ledger.attempts.filter((a) => a.arm === arm);
      const scored = rows.filter((a) => a.human_gold.status === "confirmed" && ["accepted", "rejected"].includes(a.result));
      return [arm, { attempts: rows.length, accepted: rows.filter((a) => a.result === "accepted").length,
        rejected: rows.filter((a) => a.result === "rejected").length, failed: rows.filter((a) => a.result === "failed").length,
        not_run: rows.filter((a) => a.result === "not_run").length, human_gold_pending: rows.filter((a) => a.human_gold.status === "pending").length,
        human_gold_scored: scored.length, false_accept: scored.filter((a) => a.human_gold.expected === "reject" && a.result === "accepted").length,
        false_reject: scored.filter((a) => a.human_gold.expected === "accept" && a.result === "rejected").length,
        cost_unknown: rows.filter((a) => a.cost_usd === null).length, observed_usd_lower_bound: rows.reduce((n, a) => n + (a.cost_usd ?? 0), 0) }];
    })) };
}

export function preparePodcastInventory(raw: unknown, inputSha256: string) {
  sha.parse(inputSha256);
  const worklist = worklistSchema.parse(raw);
  const runs = new Map(worklist.runs.map((r) => [r.run_id, r]));
  const attempts = new Map(worklist.attempts.map((a) => [a.attempt_id, a]));
  if (runs.size !== worklist.runs.length || attempts.size !== worklist.attempts.length
    || new Set(worklist.occurrences.map((o) => o.occurrence_id)).size !== worklist.occurrences.length) throw new Error("duplicate_input_identity");
  for (const run of worklist.runs) if (new Set(run.attempt_ids).size !== run.attempt_ids.length || run.attempt_ids.some((id) => attempts.get(id)?.run_id !== run.run_id)) throw new Error("run_attempt_binding_mismatch");
  for (const attempt of worklist.attempts) if (!runs.get(attempt.run_id)?.attempt_ids.includes(attempt.attempt_id)) throw new Error("run_attempt_binding_mismatch");
  const grouped = new Map<string, z.infer<typeof occurrenceSchema>[]>();
  for (const o of worklist.occurrences) {
    if (o.source_key !== JSON.stringify([o.ref.locator.id, o.ref.revision])) throw new Error("source_key_ref_mismatch");
    if (!runs.get(o.run_id)?.attempt_ids.includes(o.attempt_id) || attempts.get(o.attempt_id)?.run_id !== o.run_id) throw new Error("run_attempt_binding_mismatch");
    if (o.body !== null && hash(o.body) !== o.body_sha256) throw new Error("body_hash_mismatch");
    if ((o.body === null) !== (o.body_sha256 === null)) throw new Error("body_hash_presence_mismatch");
    const siblings = grouped.get(o.source_key) ?? [];
    if (siblings.some((s) => s.body_sha256 !== o.body_sha256 || s.body_kind !== o.body_kind || s.url !== o.url || s.family_component !== o.family_component)) throw new Error("revision_metadata_conflict");
    siblings.push(o); grouped.set(o.source_key, siblings);
  }
  const revisions = [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, occurrences]) => {
    const o = occurrences[0];
    let urlHash: string | null = null;
    try { const url = new URL(o.url); if (["http:", "https:"].includes(url.protocol)) urlHash = hash(stableEvidenceUrl(o.url)); } catch { /* Unknown candidate URL never becomes an episode identity. */ }
    return { source_key: key, content_item_id: o.ref.locator.id, content_v4_revision: o.ref.revision,
      body_sha256: o.body_sha256, body_kind: o.body_kind, source_family_component: o.family_component,
      source_family_status: unknown("stage0_component_is_exposure_lower_bound_not_verified_independence"),
      source_config_revision: unknown("not_retained_in_flat_worklist"), evidence_revision: unknown("content_v4_is_metadata_not_complete_evidence_version"),
      body_utf16_length: o.body?.length ?? null, candidate_url_sha256: urlHash,
      canonical_episode: unknown("no_rss_program_page_transcript_pairing_receipt_in_worklist"),
      program_page_binding: unknown("not_retained_in_flat_worklist"), episode_version: unknown("no_verified_episode_version_chain"),
      transcript_partner: unknown("no_verified_transcript_partner_in_this_input"),
      speaker_map: o.body_kind === "transcript" ? unknown("no_speaker_map_receipt") : { status: "not_applicable" as const, reason: "not_transcript" },
      segments: [], view_argument_bindings: [], locator_status: unknown("no_transcript_segment_or_semantic_human_gold"),
      source_published_at: unknown("not_retained_in_flat_worklist"), source_version_updated_at: unknown("not_observed"),
      first_available_at: unknown("not_observed"), first_collected_at: unknown("mutable_fetched_at_not_first_collection"),
      occurrence_refs: occurrences.map((s) => ({ occurrence_id: s.occurrence_id, run_id: s.run_id, attempt_id: s.attempt_id, partition: s.partition, evidence_gaps: s.evidence_gaps })),
      pairing_eligibility: o.body_kind === "show_notes" ? "show_notes_candidate_only" : o.body_kind === "transcript" ? "unverified_transcript_metadata_only" : "unclassified_article_or_unknown",
    };
  });
  const count = (kind: string) => revisions.filter((r) => r.body_kind === kind).length;
  return { schema_version: "rich-brief-podcast-shadow-preparation-v1", contract_version: "rich-brief-evidence-publication-v0", execution_scope: "shadow_preparation_only",
    input_sha256: inputSha256, production_allowed: false, experiment_execution_allowed: false, formal_holdout_opened: false,
    denominator: { registered_runs: worklist.runs.length, observed_analysis_attempts: worklist.attempts.length,
      input_occurrences: worklist.occurrences.length, exact_revisions: revisions.length,
      show_notes_occurrences: worklist.occurrences.filter((o) => o.body_kind === "show_notes").length, show_notes_revisions: count("show_notes"),
      transcript_occurrences: worklist.occurrences.filter((o) => o.body_kind === "transcript").length, transcript_metadata_revisions: count("transcript"),
      usable_sealed_transcripts: 0, verified_episode_pairs: 0, verified_speaker_maps: 0,
      acquisition_attempts: unknown("analysis_worklist_does_not_preserve_acquisition_failure_denominator") },
    runs: worklist.runs, analysis_attempts: worklist.attempts.map((a) => ({ attempt_id: a.attempt_id, run_id: a.run_id, kind: a.kind, total_candidates: a.total_candidates })),
    revisions, same_episode_pairs: [],
    evaluation_preparation: { required_case_categories: REQUIRED_C_CASES, actual_cases: 0,
      ledger: { schema_version: "rich-brief-podcast-evaluation-ledger-v1", dataset_id: "C-exploration-preparation", execution_scope: "exploration_shadow", resource_version: inputSha256, attempts: [] },
      gold_status: "human_pending", reading_effect_status: "not_evaluated", numeric_protocol_status: "T04_not_frozen" },
    release_blockers: ["sealed_transcript_and_canonical_episode_pairing_missing", "speaker_segment_view_argument_gold_missing", "analyzer_validator_attribution_execution_gate_pending", "T04_numeric_and_resource_freeze_pending", "dedicated_C_independent_eval_pending", "old_episode_claim_history_gate_pending", "production_approval_not_requested"] };
}

function privateOutput(output: string): void {
  if (!isAbsolute(output) || existsSync(output)) throw new Error("new_absolute_output_required");
  const parent = realpathSync(dirname(output)); let cursor = parent;
  while (!existsSync(join(cursor, ".git")) && dirname(cursor) !== cursor) cursor = dirname(cursor);
  if (existsSync(join(cursor, ".git"))) {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
    if (spawnSync("git", ["-C", cursor, "check-ignore", "-q", "--no-index", "--", join(parent, basename(output))], { env }).status !== 0) throw new Error("output_must_be_gitignored");
  }
}
export function prepareFromWorklist(path: string, expectedHash: string, output: string) {
  if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("absolute_regular_worklist_required");
  const bytes = readFileSync(path); if (hash(bytes) !== sha.parse(expectedHash)) throw new Error("input_resource_hash_mismatch");
  const inventory = preparePodcastInventory(JSON.parse(bytes.toString("utf8")), expectedHash);
  privateOutput(output); mkdirSync(output, { mode: 0o700 });
  const save = (file: string, value: unknown) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  save("inventory.json", inventory); save("evaluation-ledger.json", inventory.evaluation_preparation.ledger);
  save("summary.json", { ...inventory.denominator, release_blockers: inventory.release_blockers,
    evaluation: summarizePodcastEvaluation(inventory.evaluation_preparation.ledger) });
  save("manifest.json", { schema_version: "rich-brief-podcast-preparation-artifacts-v1", input_sha256: expectedHash,
    implementation_sha256: hash(readFileSync(new URL(import.meta.url))),
    artifacts: Object.fromEntries(["inventory.json", "evaluation-ledger.json", "summary.json"].map((f) => [f, hash(readFileSync(join(output, f)))])) });
  return inventory.denominator;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, expectedHash, output, ...extra] = process.argv.slice(2);
    if (!path || !expectedHash || !output || extra.length) throw new Error("usage_absolute_worklist_expected_sha256_new_output");
    console.log(JSON.stringify(prepareFromWorklist(path, expectedHash, output)));
  } catch (error) {
    const message = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "input_or_output_invalid";
    console.error(`podcast_prep:${message}`); process.exitCode = 1;
  }
}
