import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertComparableFInputs, durationHours, freshnessInputSchema, fromDensityExport, prospectiveTemplate, summarizeFreshness, unknownClock, unknownClocks, writePrivateResult, type FreshnessInput } from "./freshness.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "freshness-test-")); chmodSync(path, 0o700); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const clock = (hour: number) => ({ value: `2026-10-${hour < 24 ? "05" : "06"}T${String(hour % 24).padStart(2, "0")}:00:00.000Z`, basis: "observer" as const, evidence_ref: `clock-${hour}`, unknown_reason: null });
const input = (): FreshnessInput => prospectiveTemplate("2026-10-07T00:00:00.000Z", "2026-10-05T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
function published(i: FreshnessInput, name: string, originalHour: number | null, publishHour: number) {
  const clocks = unknownClocks(); clocks.published = clock(publishHour);
  clocks.source_published = originalHour === null ? unknownClock("missing") : clock(originalHour);
  i.publications.push({ publication_id: name, attempt_id: null, topic_id: "software", issue_id: "issue-1", source_form: "article", publication_kind: "unknown", event_id: null, proposition_id: null, primary_source_revision: null, clocks });
}

describe("F full denominators and separate clocks", () => {
  it("requires a complete identical source pool, model, budgets and failure cost ledgers before F comparison", () => {
    const a = input(), b = input();
    expect(() => assertComparableFInputs(a, b)).toThrow("F_comparison_protocol_incomplete");
    a.comparison = { arm: "F0", complete_source_pool_sha256: "a".repeat(64), complete_source_pool: true, model: "frozen-model", token_budget: 1000, usd_budget: 1, paired_run_id: "pair1" };
    b.comparison = { ...a.comparison, arm: "F1" };
    expect(() => assertComparableFInputs(a, b)).not.toThrow();
    b.comparison.token_budget = 999;
    expect(() => assertComparableFInputs(a, b)).toThrow("F_comparison_mismatch:token_budget");
    b.comparison = { ...a.comparison, arm: "F1" };
    b.attempts.push({ attempt_id: "failed", topic_id: "software", issue_id: "issue1", status: "failed", input_source_revisions: [], analyzer_started: clock(0), analyzer_completed: unknownClock("failed"), ledger: { model: "frozen-model", input_tokens: 1, output_tokens: 0, usd: null, failure_code: "failure" } });
    expect(() => assertComparableFInputs(a, b)).toThrow("F_attempt_cost_or_model_ledger_incomplete");
    b.attempts[0].ledger.usd = 2;
    expect(() => assertComparableFInputs(a, b)).toThrow("F_comparison_budget_exceeded");
  });
  it("keeps unknown and negative ages outside percentiles, in total denominator", () => {
    const i = input(); published(i, "p1", 0, 24); published(i, "p2", 0, 47); published(i, "unknown", null, 24); published(i, "negative", 30, 24);
    i.publications[0].clocks.source_version_updated = clock(23);
    const result = summarizeFreshness(i), metrics = result.by_stratum.all;
    expect(metrics.original_publish_age).toMatchObject({ total: 4, known: 2, unknown: 1, invalid_negative: 1, p50_hours: 24, p90_hours: 47, within24_of_known: .5, within24_of_total_lower_bound: .25, within48_of_total_lower_bound: .5 });
    expect(metrics.version_update_age).toMatchObject({ total: 4, known: 1, unknown: 3, p50_hours: 1 });
    expect(metrics.reader_open_age.unknown).toBe(4);
    expect(result.by_stratum["publication_kind:unknown"].publication_messages).toBe(4);
    expect(result.comparison_ready).toBe(false);
  });
  it("counts failed/no-input attempts, explicit stage losses and unknown costs", () => {
    const i = input(); i.attempts.push({ attempt_id: "failed", topic_id: "software", issue_id: "issue-1", status: "failed", input_source_revisions: [], analyzer_started: clock(0), analyzer_completed: unknownClock("failed"), ledger: { model: "m", input_tokens: 2, output_tokens: 0, usd: .02, failure_code: "parse" } });
    i.attempts.push({ ...i.attempts[0], attempt_id: "unknown", status: "unknown", input_source_revisions: ["rev1"], ledger: { ...i.attempts[0].ledger, usd: null, failure_code: null } });
    const clocks = unknownClocks(); clocks.first_available = clock(0); clocks.first_collected = clock(2); clocks.selected = clock(3);
    i.observations.push({ observation_id: "o1", attempt_id: "unknown", source_revision: "rev1", source_family: null, topic_id: "software", issue_id: "issue-1", source_form: "article", publication_kind: "first", clocks, terminal: "extraction_failed" });
    const summary = summarizeFreshness(i);
    expect(summary.attempts).toMatchObject({ total: 2, completed: 0, failed: 1, unknown: 1, without_inputs: 1, cost_unknown: 1, observed_usd_lower_bound: .02 });
    expect(summary.stage_delays["first_available->first_collected"].p50_hours).toBe(2);
    expect(summary.stage_loss["selected->extracted"]).toMatchObject({ entered_recorded: 1, progressed_recorded: 0, terminal_loss_recorded: 1, pending_or_unobserved: 0 });
  });
  it("does not turn a reading scenario into telemetry", () => {
    const i = input(); published(i, "p", 0, 24); i.reader_scenario_at = "2026-10-06T12:00:00.000Z";
    const metrics = summarizeFreshness(i).by_stratum.all;
    expect(metrics.reader_scenario_age).toMatchObject({ kind: "scenario_estimate_only", p50_hours: 36 });
    expect(metrics.reader_open_age).toMatchObject({ known: 0, unknown: 1 });
  });
  it("rejects duplicate, orphan, future or implicit clocks", () => {
    const i = input(); published(i, "p", 0, 24);
    expect(freshnessInputSchema.safeParse({ ...i, publications: [...i.publications, ...i.publications] }).success).toBe(false);
    i.publications[0].attempt_id = "missing"; expect(freshnessInputSchema.safeParse(i).success).toBe(false);
    i.publications[0].attempt_id = null;
    i.publications[0].clocks.published = { ...clock(24), value: "2026-10-08T00:00:00.000Z" };
    expect(freshnessInputSchema.safeParse(i).success).toBe(false);
    i.publications[0].clocks.published = { ...clock(24), evidence_ref: null };
    expect(freshnessInputSchema.safeParse(i).success).toBe(false);
    expect(durationHours(clock(2), clock(1))).toBe("invalid_negative");
  });
});

function exportFixture(sourceDate: string | null = "2026-10-05T00:00:00Z") {
  const root = temp();
  const pool = JSON.stringify({ kind: "batch", batch: { id: "batch1", topic_id: "software" },
    analysis_links: [{ started: { id: "start", trace_id: "trace1", attempt: 1, occurred_at: "2026-10-06T00:00:00.000Z", input_refs: JSON.stringify([{ type: "content_item", locator: { kind: "id", id: "s1" }, revision: "r1" }]), version_context: "{}" }, completed: { id: "end", trace_id: "trace1", attempt: 1, event_type: "completed", occurred_at: "2026-10-06T00:01:00.000Z" } }],
    input_evidence: [{ ref: { locator: { id: "s1" }, revision: "r1" }, snapshot: { published_at: sourceDate, fetched_at: "2026-10-06T00:00:00.000Z", body_kind: "article", title: "PRIVATE TITLE", url: "https://private.test", content_hash: "hash" }, body: "PRIVATE SOURCE BODY" }],
    report_reviews: [{ report_id: "issue1" }],
    candidates: [{ terminal: "published", insight: { id: "ins1", statement_citation_index: 1 }, citations: [{ content_item_id: "s1", citation_index: 0, quote: "PRIVATE QUOTE" }], report_outcomes: [{ report_id: "issue1", terminal: "published", generated_at: "2026-10-06T01:00:00.000Z" }] }],
  }) + "\n";
  writeFileSync(join(root, "candidate-pool.jsonl"), pool);
  writeFileSync(join(root, "snapshot-manifest.json"), JSON.stringify({ format_version: "brief-density-s0-v2", as_of: "2026-10-07T00:00:00.000Z", window: { from_inclusive: "2026-10-05T00:00:00.000Z", until_exclusive: "2026-10-07T00:00:00.000Z" }, artifact_hashes: { "candidate-pool.jsonl": createHash("sha256").update(pool).digest("hex") } }));
  return root;
}
describe("sealed export recovery and private output", () => {
  it("recovers age/execution only and keeps mutable fetched_at out of first clocks", () => {
    const result = fromDensityExport(exportFixture());
    expect(result.observations[0].clocks.first_collected.value).toBeNull();
    expect(result.observations[0].clocks.first_available.value).toBeNull();
    expect(result.observations[0].clocks.source_version_updated.value).toBeNull();
    expect(result.observations[0].clocks.published.value).toBeNull();
    expect(summarizeFreshness(result).analyze_execution_delay.p50_hours).toBeCloseTo(1 / 60);
    expect(summarizeFreshness(result).by_stratum.all.original_publish_age.p50_hours).toBe(25);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("https://private.test");
    expect(result.publications[0].publication_kind).toBe("unknown");
  });
  it("does not silently invent a midnight hour for date-only source dates", () => {
    const result = fromDensityExport(exportFixture("2026-10-05"));
    expect(result.publications[0].clocks.source_published).toMatchObject({ value: null, unknown_reason: "timestamp_precision_or_timezone_unknown" });
  });
  it("rejects modified exports and existing destinations; writes owner-only artifacts", () => {
    const root = exportFixture(); const result = fromDensityExport(root), output = join(root, "output");
    writePrivateResult(output, result);
    expect(lstatSync(output).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(output, "observations.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).observations_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => writePrivateResult(output, result)).toThrow("new_absolute_output_required");
    writeFileSync(join(root, "candidate-pool.jsonl"), "{}\n");
    expect(() => fromDensityExport(root)).toThrow("export_pool_hash_mismatch");
  });
});
