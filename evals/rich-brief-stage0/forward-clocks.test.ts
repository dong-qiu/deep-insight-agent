import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendForwardEvent, assembleForwardClocks, createForwardJournal, forwardJournalConfigSchema, readForwardJournal, type ForwardEvent, type ForwardJournalConfig } from "./forward-clocks";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const at = (hour: number) => new Date(Date.parse("2026-10-05T00:00:00.000Z") + hour * 3_600_000).toISOString();
const recorded = "2026-10-06T22:00:00.000Z", asOf = "2026-10-07T00:00:00.000Z";
const window = { from_inclusive: at(0), until_exclusive: asOf };
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "forward-clocks-")); roots.push(root);
  const body = "PRIVATE BODY must never enter journal output", bodyPath = join(root, "body.txt");
  writeFileSync(bodyPath, body, { mode: 0o600 });
  const source = { source_id: "content1", revision: "content-v4:exact1", body_sha256: sha(body) };
  const config: ForwardJournalConfig = { format_version: "forward-clock-journal-v1", journal_id: "journal1", run_id: "run1", scope: "exploration",
    sources: [{ ...source, topic_id: "software", issue_id: "issue1", source_form: "paper_fulltext", source_family: null }] };
  const directory = join(root, "journal"); createForwardJournal(directory, config);
  let serial = 0;
  const receipt = (value: unknown = { result: "observed" }, role: "receipt" | "publication_commit" | "metadata" = "receipt") => {
    const text = JSON.stringify(value), path = join(root, `receipt-${serial++}.json`); writeFileSync(path, text, { mode: 0o600 }); return { path, sha256: sha(text), role };
  };
  const event = (kind: ForwardEvent["kind"], hour: number, attempt = "analysis1", extra: Record<string, unknown> = {}) => ({
    event_id: `event-${serial++}`, run_id: "run1", attempt_id: attempt, attempt_kind: attempt.startsWith("acq") ? "source_acquisition" : "analysis",
    source, observed_at: at(hour), resources: kind === "availability_observed" && extra.result === "available" ? [
      receipt({ format_version: "forward-positive-observation-v1", run_id: "run1", attempt_id: attempt, source, observed_at: at(hour), http_status: 200,
        source_body: { path: bodyPath, sha256: source.body_sha256 } }), { path: bodyPath, sha256: source.body_sha256, role: "source_body" },
    ] : [receipt()], kind, ...extra,
  });
  const append = (e: ReturnType<typeof event>) => appendForwardEvent(directory, e, recorded);
  const collect = (hour = 1, attempt = "acq1") => append(event("collected", hour, attempt, { resources: [{ path: bodyPath, sha256: source.body_sha256, role: "source_body" }] }));
  const finish = (hour: number, attempt: string, status = "completed", usd: number | null = .1) => append(event("attempt_finished", hour, attempt, { status,
    ledger: { model: attempt.startsWith("acq") ? null : "model1", input_tokens: null, output_tokens: null, usd, failure_code: status === "failed" ? "failed" : null } }));
  const commit = (hour: number, attempt = "analysis1", publication = "publication1") => {
    const artifact = receipt({ publication_id: publication, sources: [source] });
    return append(event("publication_committed", hour, attempt, { publication_id: publication, resources: [artifact,
      receipt({ format_version: "forward-publication-commit-v1", run_id: "run1", attempt_id: attempt, source, publication_id: publication,
        committed_at: at(hour), artifact_resource: { path: artifact.path, sha256: artifact.sha256 } }, "publication_commit")],
    }));
  };
  return { root, directory, source, config, bodyPath, receipt, event, append, collect, finish, commit };
}
function pipeline(f: ReturnType<typeof fixture>) {
  f.collect(); f.finish(1.1, "acq1", "completed", 0);
  f.append(f.event("attempt_started", 2)); f.append(f.event("selected", 3)); f.append(f.event("extracted", 4));
  f.append(f.event("evidence_pass", 5)); f.commit(6); f.finish(7, "analysis1");
}
describe("forward exploration clock journal", () => {
  it("writes owner-only immutable records and separates current collection from lifetime first", () => {
    const f = fixture(); pipeline(f);
    const journal = readForwardJournal(f.directory), result = assembleForwardClocks(journal, asOf, window);
    expect(Object.isFrozen(journal.entries)).toBe(true);
    expect(lstatSync(f.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.directory, "0000000001.json")).mode & 0o777).toBe(0o600);
    expect(result.input.observations[0].clocks).toMatchObject({ first_available: { value: null }, first_collected: { value: null },
      selected: { value: at(3) }, extracted: { value: at(4) }, evidence_pass: { value: at(5) }, published: { value: at(6), basis: "artifact_commit" }, reader_open: { value: null } });
    expect(result.observed_stage_delays["current_collection->selected"]).toEqual({ total: 1, known: 1, unknown: 0, p50_hours: 2, p90_hours: 2 });
    expect(result.summary.stage_delays["first_collected->selected"].known).toBe(0);
    expect(result.summary.analyze_execution_delay.p50_hours).toBe(2); // completion is extraction, not the later finish/publication.
    expect(result.acquisition_attempts).toMatchObject({ total: 1, completed: 1, observed_usd_lower_bound: 0 });
    expect(result.summary.attempts.total).toBe(1);
    expect(result.summary.comparison_ready).toBe(false);
    expect(result.improvement_claim).toBe(false); expect(result.formal_holdout_opened).toBe(false);
    expect(result.input.reader_scenario_at).toBeNull(); expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
  });
  it("preserves a confirmed-negative interval without certifying first availability", () => {
    const f = fixture(), negative = f.event("availability_observed", 0, "acq0", { result: "unavailable", reason: "exact_revision_not_found" });
    negative.resources = [f.receipt({ format_version: "forward-negative-observation-v1", run_id: "run1", attempt_id: "acq0", source: f.source,
      observed_at: at(0), reason: "exact_revision_not_found", http_status: 404 })];
    f.append(negative); f.finish(.1, "acq0", "completed", 0);
    f.append(f.event("availability_observed", 1, "acq1", { result: "available", reason: "captured_success" })); f.finish(1.1, "acq1", "completed", 0);
    const result = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(result.source_availability[0]).toMatchObject({ first_observed_available: { value: at(1) }, last_negative_before_first_observed: { value: at(0) },
      availability_interval: { lower_exclusive: at(0), upper_inclusive: at(1), exact_first_available_certified: false } });
  });
  it("does not treat one success, 403, missing or same-resolution negatives as exact availability", () => {
    const f = fixture();
    const bad = f.event("availability_observed", 0, "acq0", { result: "unavailable", reason: "403" });
    bad.resources = [f.receipt({ format_version: "forward-negative-observation-v1", run_id: "run1", attempt_id: "acq0", source: f.source, observed_at: at(0), reason: "403", http_status: 403 })];
    expect(() => f.append(bad)).toThrow("confirmed_negative_receipt_required");
    f.append(f.event("availability_observed", 0, "acq0", { result: "unknown", reason: "403" })); f.finish(.1, "acq0", "unknown", null);
    f.append(f.event("availability_observed", 1, "acq1", { result: "available", reason: "single_success" }));
    const result = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(result.source_availability[0].availability_interval?.lower_exclusive).toBeNull();
    expect(result.source_availability[0].last_negative_before_first_observed.value).toBeNull();
    expect(result.acquisition_attempts).toMatchObject({ total: 2, unknown: 2, cost_unknown: 2 });
  });
  it("requires success receipt and exact captured body for available observations", () => {
    const f = fixture(), e = f.event("availability_observed", 1, "acq1", { result: "available", reason: "unproved" });
    expect(() => f.append({ ...e, resources: [f.receipt({ result: "observed" })] })).toThrow("confirmed_positive_receipt_required");
    const proof = { format_version: "forward-positive-observation-v1", run_id: "run1", attempt_id: "acq1", source: f.source,
      observed_at: at(1), http_status: 403, source_body: { path: f.bodyPath, sha256: f.source.body_sha256 } };
    expect(() => f.append({ ...e, resources: [f.receipt(proof), e.resources[1]] })).toThrow("confirmed_positive_receipt_required");
    expect(() => f.append({ ...e, resources: [e.resources[0]] })).toThrow("confirmed_positive_receipt_required");
    expect(() => f.append({ ...e, resources: [f.receipt({ ...proof, http_status: 200, attempt_id: "other" }), e.resources[1]] })).toThrow("confirmed_positive_receipt_required");
    f.append(e);
  });
  it("counts failed, unknown and empty analysis attempts and unknown costs independently", () => {
    const f = fixture(); f.collect(); f.finish(1.1, "acq1", "completed", 0);
    f.append(f.event("selected", 2)); f.append(f.event("stage_failed", 3, "analysis1", { stage: "extraction", reason: "parse" })); f.finish(4, "analysis1", "failed", .2);
    f.append(f.event("attempt_started", 5, "analysis2")); f.finish(6, "analysis2", "unknown", null);
    f.append(f.event("stage_failed", 7, "acq2", { stage: "collection", reason: "network" })); f.finish(8, "acq2", "failed", null);
    const r = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(r.summary.attempts).toMatchObject({ total: 2, failed: 1, unknown: 1, without_inputs: 1, cost_unknown: 1, observed_usd_lower_bound: .2 });
    expect(r.acquisition_attempts).toMatchObject({ total: 2, completed: 1, failed: 1, cost_unknown: 1 });
    expect(r.summary.stage_loss["selected->extracted"]).toMatchObject({ entered_recorded: 1, terminal_loss_recorded: 1 });
    expect(r.observed_stage_delays["selected->extracted"]).toMatchObject({ total: 1, known: 0, unknown: 1, p50_hours: null, p90_hours: null });
  });
  it("retains explicit publication failure independently of the freshness terminal vocabulary", () => {
    const f = fixture(); f.collect(); f.append(f.event("selected", 2)); f.append(f.event("extracted", 3)); f.append(f.event("evidence_pass", 4));
    f.append(f.event("stage_failed", 5, "analysis1", { stage: "publication", reason: "artifact_commit_failed" })); f.finish(6, "analysis1", "failed", null);
    const r = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(r.observed_stage_failures).toMatchObject({ total: 1, by_stage: { publication: 1 } });
    expect(r.current_stage_rows[0].failed_stage).toBe("publication");
    expect(r.summary.attempts.failed).toBe(1);
    expect(r.observed_stage_delays["evidence_pass->publication_commit"]).toMatchObject({ known: 0, unknown: 1 });
  });
  it("keeps same-resolution negatives out of the availability interval and respects sequence for collection", () => {
    const f = fixture(), negative = f.event("availability_observed", 1, "acq0", { result: "unavailable", reason: "not_found" });
    negative.resources = [f.receipt({ format_version: "forward-negative-observation-v1", run_id: "run1", attempt_id: "acq0", source: f.source,
      observed_at: at(1), reason: "not_found", http_status: 404 })];
    f.append(negative); f.finish(1, "acq0", "completed", null);
    f.append(f.event("availability_observed", 1, "acq1", { result: "available", reason: "success" }));
    f.collect(1, "acq1"); f.finish(1, "acq1", "completed", null);
    f.append(f.event("selected", 2)); f.collect(2, "acq2");
    const r = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(r.source_availability[0].availability_interval?.lower_exclusive).toBeNull();
    expect(r.current_stage_rows[0].collection).toMatchObject({ value: at(1) });
    expect(r.observed_stage_delays["current_collection->selected"].p50_hours).toBe(1);
  });
  it("rejects duplicate event, phase, publication, run, body, attempt kind and end-state drift", () => {
    const f = fixture(); f.collect(); const selected = f.event("selected", 2); f.append(selected);
    expect(() => f.append(selected)).toThrow("duplicate_event_id");
    expect(() => f.append(f.event("selected", 3))).toThrow("duplicate_stage");
    expect(() => f.append({ ...f.event("extracted", 3), run_id: "another" })).toThrow("run_binding_mismatch");
    expect(() => f.append({ ...f.event("extracted", 3), source: { ...f.source, body_sha256: "f".repeat(64) } })).toThrow("source_version_or_body_drift");
    expect(() => f.append({ ...f.event("attempt_finished", 3, "acq1", { status: "unknown", ledger: { model: null, input_tokens: null, output_tokens: null, usd: null, failure_code: null } }), attempt_kind: "analysis" })).toThrow("attempt_binding_drift");
    f.append(f.event("extracted", 3)); f.append(f.event("evidence_pass", 4)); f.commit(5); f.finish(6, "analysis1");
    expect(() => f.append(f.event("source_clock", 7, "analysis1", { name: "source_published", value: at(0) }))).toThrow("attempt_already_finished");
    f.append(f.event("selected", 7, "analysis2")); f.append(f.event("extracted", 8, "analysis2")); f.append(f.event("evidence_pass", 9, "analysis2"));
    expect(() => f.commit(10, "analysis2", "publication1")).toThrow("duplicate_publication_id");
  });
  it("rejects out-of-order stages, future clocks, late start, recollection and failed-stage continuation", () => {
    const f = fixture(); expect(() => f.append(f.event("selected", 0))).toThrow("selection_requires_collection");
    f.collect(); expect(() => f.append(f.event("extracted", 2))).toThrow("extraction_requires_selection");
    f.append(f.event("selected", 2)); expect(() => f.append(f.event("attempt_started", 3))).toThrow("duplicate_or_late_attempt_start");
    expect(() => f.collect(3, "analysis1")).toThrow("collection_stage_order_rejected");
    expect(() => f.append(f.event("extracted", 1.5))).toThrow("observation_order_rejected");
    const future = { ...f.event("extracted", 3), observed_at: "2099-01-01T00:00:00.000Z" };
    expect(() => f.append(future)).toThrow("future_observation_or_recording");
    f.append(f.event("stage_failed", 3, "analysis1", { stage: "extraction", reason: "invalid_output" }));
    expect(() => f.append(f.event("extracted", 4))).toThrow("failed_source_requires_new_attempt");
    expect(() => f.finish(4, "analysis1", "completed")).toThrow("failed_attempt_cannot_complete");
  });
  it("rejects expanded-year timestamps before lexical future/order/window comparisons", () => {
    const f = fixture(), expanded = "+010000-01-01T00:00:00.000Z";
    expect(() => f.append({ ...f.event("attempt_started", 0), observed_at: expanded })).toThrow();
    expect(() => appendForwardEvent(f.directory, f.event("attempt_started", 0), expanded)).toThrow();
    expect(() => assembleForwardClocks(readForwardJournal(f.directory), expanded, window)).toThrow();
    expect(() => assembleForwardClocks(readForwardJournal(f.directory), asOf, { ...window, from_inclusive: expanded })).toThrow();
    expect(() => assembleForwardClocks(readForwardJournal(f.directory), asOf, { ...window, until_exclusive: expanded })).toThrow();
    expect(() => f.append(f.event("source_clock", 0, "acq0", { name: "event_at", value: expanded, resources: [f.receipt({}, "metadata")] }))).toThrow();
  });
  it("requires exact body material and an actual bound commit receipt, not generated_at", () => {
    const f = fixture(); expect(() => f.append(f.event("collected", 0, "acq1"))).toThrow("collection_body_evidence_required");
    f.collect(); f.append(f.event("selected", 2)); f.append(f.event("extracted", 3)); f.append(f.event("evidence_pass", 4));
    expect(() => f.append(f.event("publication_committed", 5, "analysis1", { publication_id: "p" }))).toThrow("publication_commit_receipt_required");
    const proxy = f.event("publication_committed", 5, "analysis1", { publication_id: "p", resources: [f.receipt({ generated_at: at(5) }, "publication_commit")] });
    expect(() => f.append(proxy)).toThrow();
    const artifact = f.receipt({ publication_id: "p", sources: [f.source] });
    const wrong = f.event("publication_committed", 5, "analysis1", { publication_id: "p", resources: [artifact, f.receipt({ format_version: "forward-publication-commit-v1", run_id: "run1", attempt_id: "wrong", source: f.source,
      publication_id: "p", committed_at: at(5), artifact_resource: { path: artifact.path, sha256: artifact.sha256 } }, "publication_commit")] });
    expect(() => f.append(wrong)).toThrow("publication_commit_binding_mismatch");
    const omitted = f.event("publication_committed", 5, "analysis1", { publication_id: "p", resources: [f.receipt({
      format_version: "forward-publication-commit-v1", run_id: "run1", attempt_id: "analysis1", source: f.source,
      publication_id: "p", committed_at: at(5), artifact_resource: { path: artifact.path, sha256: artifact.sha256 } }, "publication_commit")] });
    expect(() => f.append(omitted)).toThrow("publication_artifact_resource_required");
    f.commit(5); const entries = readForwardJournal(f.directory).entries;
    const commit = entries.at(-1)!.event, output = commit.resources.find((r) => r.role === "receipt")!;
    writeFileSync(output.path, "artifact changed");
    expect(() => readForwardJournal(f.directory)).toThrow("evidence_resource_hash_drift");
  });
  it("replays resource and chain integrity and rejects mutable permissions/symlinks", () => {
    const f = fixture(); f.collect(); const before = readFileSync(join(f.directory, "0000000001.json"));
    writeFileSync(f.bodyPath, "changed"); expect(() => readForwardJournal(f.directory)).toThrow("evidence_resource_hash_drift");
    writeFileSync(f.bodyPath, "PRIVATE BODY must never enter journal output");
    const entry = JSON.parse(before.toString()); entry.event.observed_at = at(0); writeFileSync(join(f.directory, "0000000001.json"), JSON.stringify(entry));
    expect(() => readForwardJournal(f.directory)).toThrow("journal_chain_drift");
    writeFileSync(join(f.directory, "0000000001.json"), before); chmodSync(join(f.directory, "0000000001.json"), 0o644);
    expect(() => readForwardJournal(f.directory)).toThrow("private_permissions_required"); chmodSync(join(f.directory, "0000000001.json"), 0o600);
    const link = join(f.root, "link.txt"); symlinkSync(f.bodyPath, link);
    expect(() => f.append(f.event("availability_observed", 2, "acq2", { result: "available", reason: "test", resources: [{ path: link, sha256: f.source.body_sha256, role: "receipt" }] }))).toThrow("canonical_non_symlink_path_required");
  });
  it("rejects config/sequence/in-memory drift, windows that omit records and formal scope", () => {
    const f = fixture(); f.collect(); const journal = readForwardJournal(f.directory);
    const changed = structuredClone(journal); changed.config.sources[0].source_form = "transcript";
    expect(() => assembleForwardClocks(changed, asOf, window)).toThrow("journal_config_drift");
    expect(() => assembleForwardClocks(journal, at(.5), { from_inclusive: at(0), until_exclusive: at(.5) })).toThrow("journal_beyond_as_of");
    expect(() => assembleForwardClocks(journal, asOf, { from_inclusive: at(2), until_exclusive: asOf })).toThrow("journal_observations_outside_window");
    expect(forwardJournalConfigSchema.safeParse({ ...f.config, scope: "formal_holdout" }).success).toBe(false);
    expect(() => createForwardJournal(f.directory, f.config)).toThrow("new_absolute_journal_required");
    const config = JSON.parse(readFileSync(join(f.directory, "config.json"), "utf8")); config.run_id = "altered"; writeFileSync(join(f.directory, "config.json"), JSON.stringify(config));
    expect(() => readForwardJournal(f.directory)).toThrow("journal_config_drift");
  });
  it("keeps explicit original and version clocks separate and never fills date-only metadata", () => {
    const f = fixture(), meta = f.receipt({ source_date: at(0) }, "metadata");
    f.append(f.event("source_clock", 0, "acq0", { name: "source_published", value: at(0), resources: [meta] })); f.finish(.1, "acq0", "completed", null);
    expect(() => f.append(f.event("source_clock", .2, "acq1", { name: "source_version_updated", value: "2026-10-05", resources: [meta] }))).toThrow();
    f.collect(1, "acq1"); f.append(f.event("selected", 2)); f.append(f.event("extracted", 3)); f.append(f.event("evidence_pass", 4)); f.commit(5);
    const r = assembleForwardClocks(readForwardJournal(f.directory), asOf, window);
    expect(r.summary.by_stratum.all.original_publish_age.p50_hours).toBe(5);
    expect(r.summary.by_stratum.all.version_update_age.known).toBe(0);
    expect(r.summary.by_stratum.all.reader_open_age.known).toBe(0);
    expect(r.input.publications[0].publication_kind).toBe("unknown");
  });
});
