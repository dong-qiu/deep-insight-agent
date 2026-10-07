import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { podcastEvaluationLedgerSchema, prepareFromWorklist, preparePodcastInventory, summarizePodcastEvaluation } from "./prepare.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function worklist() {
  const body = "PRIVATE show notes: Host: Is this true? Guest: perhaps. 😀";
  const ref = { type: "content_item", role: "input", locator: { kind: "id", id: "ci_example" }, revision: `content-v4:${"a".repeat(64)}` };
  return { schema_version: "rich-brief-stage0-input-v1", topic: "t_code_agents", exposure: { formal_holdout: 0, semantic_family_completeness: "unknown" },
    runs: [{ run_id: "r1", scheduled_at: "2026-10-07T00:00:00.000Z", status: "observed", attempt_ids: ["a1", "a2"] }],
    attempts: [{ run_id: "r1", attempt_id: "a1", kind: "batch", total_candidates: 2 }, { run_id: "r1", attempt_id: "a2", kind: "trace_without_batch", total_candidates: "unknown" }],
    occurrences: ["a1", "a2"].map((attempt, i) => ({ occurrence_id: `o${i}`, run_id: "r1", attempt_id: attempt, ref,
      source_key: JSON.stringify([ref.locator.id, ref.revision]), body, body_sha256: sha(body), body_kind: "show_notes", title: "PRIVATE TITLE",
      url: "https://private-user:private-password@example.test/episode?token=private-token&lang=en", family_component: "family1", evidence_gaps: [], partition: "exploration" })) };
}
describe("C metadata-only preparation", () => {
  it("retains the full run/failure/input denominator without upgrading show notes or guessing speakers", () => {
    const input = worklist(), result = preparePodcastInventory(input, sha("input"));
    expect(result.denominator).toMatchObject({ registered_runs: 1, observed_analysis_attempts: 2, input_occurrences: 2, exact_revisions: 1, show_notes_occurrences: 2, show_notes_revisions: 1,
      transcript_metadata_revisions: 0, usable_sealed_transcripts: 0, verified_episode_pairs: 0, verified_speaker_maps: 0 });
    const item = result.revisions[0];
    expect(item.body_utf16_length).toBe(input.occurrences[0].body.length);
    expect(item.canonical_episode.status).toBe("unknown"); expect(item.transcript_partner.status).toBe("unknown");
    expect(item.speaker_map.status).toBe("not_applicable"); expect(item.segments).toEqual([]); expect(item.view_argument_bindings).toEqual([]);
    expect(result.analysis_attempts[1].total_candidates).toBe("unknown");
    expect(result.experiment_execution_allowed).toBe(false); expect(result.production_allowed).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-user|private-password|private-token|https:\/\//);
    expect(item.candidate_url_sha256).toBe(sha("https://example.test/episode?lang=en"));
  });
  it("does not certify transcript metadata as sealed evidence or a same-episode pair", () => {
    const input = worklist(); input.occurrences.forEach((o) => { o.body_kind = "transcript"; });
    const result = preparePodcastInventory(input, sha("input"));
    expect(result.denominator.transcript_metadata_revisions).toBe(1);
    expect(result.denominator.usable_sealed_transcripts).toBe(0);
    expect(result.revisions[0].speaker_map.status).toBe("unknown"); expect(result.same_episode_pairs).toEqual([]);
  });
  it("rejects formal holdout, body/hash tampering, reused occurrence and conflicting revision metadata", () => {
    const input = worklist();
    expect(() => preparePodcastInventory({ ...input, exposure: { ...input.exposure, formal_holdout: 1 } }, sha("input"))).toThrow();
    expect(() => preparePodcastInventory({ ...input, occurrences: [{ ...input.occurrences[0], partition: "formal_holdout" }] }, sha("input"))).toThrow();
    expect(() => preparePodcastInventory({ ...input, occurrences: [{ ...input.occurrences[0], body_sha256: sha("other") }] }, sha("input"))).toThrow("body_hash_mismatch");
    expect(() => preparePodcastInventory({ ...input, occurrences: [input.occurrences[0], input.occurrences[0]] }, sha("input"))).toThrow("duplicate_input_identity");
    input.occurrences[1].body_kind = "transcript";
    expect(() => preparePodcastInventory(input, sha("input"))).toThrow("revision_metadata_conflict");
  });
  it("pins exact worklist bytes, protects destinations/symlinks, and writes owner-only metadata artifacts", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "podcast-prep-"))); roots.push(root); chmodSync(root, 0o700);
    const path = join(root, "worklist.json"), body = JSON.stringify(worklist()); writeFileSync(path, body);
    const output = join(root, "output");
    expect(() => prepareFromWorklist(path, sha("other"), output)).toThrow("input_resource_hash_mismatch");
    prepareFromWorklist(path, sha(body), output);
    expect(statSync(output).mode & 0o777).toBe(0o700); expect(statSync(join(output, "inventory.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).input_sha256).toBe(sha(body));
    expect(() => prepareFromWorklist(path, sha(body), output)).toThrow("new_absolute_output_required");
    const link = join(root, "linked.json"); symlinkSync(path, link);
    expect(() => prepareFromWorklist(link, sha(body), join(root, "other"))).toThrow("absolute_regular_worklist_required");
  });
});

function ledgerAttempt() {
  return { attempt_id: "a1", arm: "transcript", episode_pair_id: null, source_revision: "revision1", case_kind: "unknown_map_named_attribution", speaker_stratum: "unknown",
    human_gold: { status: "pending", expected: null as string | null, receipt_sha256: null as string | null }, result: "failed", failure_code: "model_failed" as string | null,
    model: "m", prompt_sha256: sha("prompt"), input_tokens: null, output_tokens: null, cost_usd: null as number | null, bytes: null, duration_ms: null,
    evidence: { canonical_episode_id: null, evidence_revision: null, speaker_map_sha256: null,
      segments: [] as { segment_id: string; speaker_id: string | null; role: string; char_start: number; char_end: number; quote_sha256: string; source_locator_ref: string }[], view_segment_ids: [] as string[], argument_segment_ids: [], qualifier_segment_ids: [] } };
}
function ledger() { return { schema_version: "rich-brief-podcast-evaluation-ledger-v1", dataset_id: "fixture-not-real-cohort", execution_scope: "synthetic_test", resource_version: "fixture-v1", attempts: [ledgerAttempt()] }; }
describe("dedicated C evaluation accounting contract", () => {
  it("keeps failed/pending/unknown costs and separate experiment arms; AI cannot self-score pending gold", () => {
    const input = ledger(); input.attempts.push({ ...ledgerAttempt(), attempt_id: "a2", arm: "show_notes", result: "accepted", failure_code: null });
    const result = summarizePodcastEvaluation(input);
    expect(result.arms.transcript).toMatchObject({ attempts: 1, failed: 1, human_gold_pending: 1, human_gold_scored: 0, cost_unknown: 1, observed_usd_lower_bound: 0 });
    expect(result.arms.show_notes).toMatchObject({ accepted: 1, human_gold_scored: 0, false_accept: 0 });
    expect(result.production_allowed).toBe(false);
    input.attempts[1].human_gold = { status: "confirmed", expected: "reject", receipt_sha256: sha("human-receipt") };
    expect(summarizePodcastEvaluation(input).arms.show_notes.false_accept).toBe(1);
    input.attempts[1].result = "rejected"; input.attempts[1].human_gold.expected = "accept";
    expect(summarizePodcastEvaluation(input).arms.show_notes.false_reject).toBe(1);
  });
  it("requires confirmed human receipt, verified map hash and bounded segment references", () => {
    const input = ledger(); input.attempts[0].human_gold.status = "confirmed";
    expect(podcastEvaluationLedgerSchema.safeParse(input).success).toBe(false);
    input.attempts[0].human_gold.status = "pending"; input.attempts[0].speaker_stratum = "verified";
    expect(podcastEvaluationLedgerSchema.safeParse(input).success).toBe(false);
    input.attempts[0].speaker_stratum = "unknown"; input.attempts[0].evidence.view_segment_ids = ["missing-segment"];
    expect(podcastEvaluationLedgerSchema.safeParse(input).success).toBe(false);
  });
});
