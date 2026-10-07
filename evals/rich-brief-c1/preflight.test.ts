import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../../src/lib/db/provenance-facts.js";
import { ANALYZE_BODY_CHARS, ANALYZER_SYSTEM, truncateForAnalyze } from "../../src/lib/agents/analyzer.js";
import type { PreparedData, FreezeProtocol } from "../rich-brief-stage0/data.js";
import { requiredRuntimeRoles } from "../rich-brief-stage0/data.js";
import { fileResource, jsonBytes } from "./common.js";
import { assertMachineMatchesStage0, buildMachineInput, validateMachineInput, type ReplayAttempt } from "./input.js";
import { callLedgerContract, summarizeLedger, validateLedger, type CallLedgerEntry } from "./ledger.js";
import { checkExecutionPreflight, verifyFrozenProtocol, type ExecutionPlan } from "./preflight.js";
import { candidateFirstExtractionPrompt } from "./prepare.js";
import { attestSnapshot } from "./snapshot.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const shaA = "a".repeat(64), shaB = "b".repeat(64);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rich-brief-c1-")));
  const write = (name: string, value: unknown) => { const path = join(root, name); writeFileSync(path, jsonBytes(value), { mode: 0o600 }); return fileResource(path); };
  const body = "Source evidence. " + "x".repeat(ANALYZE_BODY_CHARS + 50);
  const data: PreparedData = { schema_version: "rich-brief-stage0-input-v1", topic: "t_code_agents", reader_goal: "Tool adoption", resources: [],
    runs: [{ run_id: "run-a", scheduled_at: "2026-10-03T17:00:00.000Z", status: "observed", attempt_ids: ["trace-a:1"] }],
    attempts: [{ attempt_id: "trace-a:1", run_id: "run-a", kind: "trace_without_batch", total_candidates: "unknown", observed_candidates: 0, input_status: "recorded", cutoff: "unknown" }],
    occurrences: [{ occurrence_id: "occ-a", run_id: "run-a", attempt_id: "trace-a:1", source_key: "key-a", ref: { type: "content_item", locator: { kind: "id", id: "source-a" }, revision: "revision-a", role: "input" },
      body_sha256: hash(body), body, body_kind: "article", title: "Title", url: "https://example.test/a", evidence_gaps: [], family_component: "family-a", partition: "exploration" }],
    exposure: { source_versions: 1, known_components: 1, known_edges: 0, formal_holdout: 0, component_by_source: {}, semantic_family_completeness: "unknown" }, inherited_labels: { path: "/gold-private-secret.json", sha256: shaA } };
  const replay: ReplayAttempt = { attempt_id: "trace-a:1", topic: { id: "t_code_agents", name: "Coding", keywords: ["coding"], language: "zh", brief_schedule: "daily", enabled: true },
    items: [{ id: "source-a", source_id: "publisher-a", title: "Title", url: "https://example.test/a", author: null, published_at: null, fetched_at: "2026-10-03T16:00:00.000Z", language: "en", topic_ids: ["t_code_agents"], tags: [],
      body, body_kind: "article", raw_ref: "raw/source-a.txt", content_hash: hash(body), fetch_status: "ok" }],
    time_window: { start: "2026-09-26T17:00:00.000Z", end: "2026-10-03T17:00:00.000Z" },
    history: { status: "cutoff_safe_lower_bound", events: [], excluded_after_cutoff: 1, unproven_publication_occurrences: 2, reason: "Synthetic fixture, original history unknown" }, snapshot_resources: [] };
  const machine = buildMachineInput(data, shaA, [replay], []), machineResource = write("machine.json", machine);
  const ledgerResource = write("ledger-contract.json", callLedgerContract), baselinePrompt = write("baseline-prompt.json", { prompt: "synthetic" }), candidatePrompt = write("candidate-prompt.json", { prompt: "synthetic-c1" });
  const plan: ExecutionPlan = { schema_version: "rich-brief-c1-execution-plan-v1", status: "prepared_not_executable", production_enabled: false, c1_prompt_injection: "missing_reviewed_shadow_interface",
    baseline: "analyze_including_filterByQuoteCoverage_then_validateBatch", c1: "same_analyze_output_schema_derivation_and_common_real_gates", machine_resource: machineResource,
    ledger_contract_resource: ledgerResource, baseline_prompt_resource: baselinePrompt, candidate_prompt_resource: candidatePrompt, production_code_resources: [ledgerResource], intervention: "first_extraction_prompt_only", human_gold_to_extractor: false };
  const planResource = write("plan.json", plan);
  const role = (name: typeof requiredRuntimeRoles[number]) => ({ role: name, model: name === "extractor" ? "model-a" : "model-b", model_revision: "version-a", provider: "provider-a", transport_revision: "transport-a",
    model_resource: baselinePrompt, provider_resource: baselinePrompt, prompt_resource: baselinePrompt, policy_resource: baselinePrompt, max_output_tokens: 2048,
    cache: { status: "known" as const, mode: "off" as const, namespace: null, snapshot: null, policy_resource: baselinePrompt },
    thinking: { status: "known" as const, enabled: false, budget_tokens: 0, source: "explicit-off", transport_revision: "disabled-v1", policy_resource: baselinePrompt } });
  const arm: FreezeProtocol["arms"][number] = { arm_id: "C1", task: "first_extraction", input_sha256: shaA, model: "model-a", provider: "provider-a", model_revision: "version-a", prompt_sha256: baselinePrompt.sha256,
    token_budget: 10000, cost_budget_usd: 10, timeout_ms: 10000, max_attempts: 2, failure_policy: "record", cost_accounting: "record", stop_rule: "stop", ledger_schema_sha256: ledgerResource.sha256,
    runtime_roles: requiredRuntimeRoles.map(role), runtime_policies: {} };
  const extractor = arm.runtime_roles[0];
  const entry: CallLedgerEntry = { schema_version: "rich-brief-c1-call-ledger-v1", execution_scope: "shadow", frozen_protocol_sha256: shaB,
    arm_id: "C1", run_id: "run-a", source_attempt_id: "trace-a:1", call_id: "call-1", retry_of: null, attempt: 1, operation: "extractor", machine_input_sha256: machineResource.sha256, operation_input_sha256: shaA,
    model: extractor.model, model_revision: extractor.model_revision, provider: extractor.provider, transport_revision: extractor.transport_revision, prompt_sha256: extractor.prompt_resource.sha256,
    policy_sha256: extractor.policy_resource.sha256, cache_config_sha256: canonicalHash(extractor.cache), thinking_config_sha256: canonicalHash(extractor.thinking), output_token_cap: extractor.max_output_tokens,
    started_at: "2026-10-03T17:00:00.000Z", ended_at: "2026-10-03T17:00:01.000Z", elapsed_ms: 1000, terminal: "failed", failure_reason: "synthetic timeout", output_sha256: null,
    tokens: { status: "unknown", reason: "provider failed before usage receipt" }, cost: { status: "unknown", reason: "failure may be billable; no receipt" } };
  const expected = { frozen_sha256: shaB, machine_sha256: machineResource.sha256, registered: [{ run_id: "run-a", attempt_id: "trace-a:1" }] };
  return { root, write, data, replay, machine, machineResource, plan, planResource, arm, entry, expected };
}

describe("C1 closed machine preparation", () => {
  it("keeps failed attempts, exact bodies and source occurrences while excluding scorer pointers", () => {
    const f = fixture(); expect(f.machine.attempts[0].original_total_candidates).toBe("unknown");
    expect(f.machine.attempts[0].items[0].body).toBe(f.data.occurrences[0].body);
    expect(JSON.stringify(f.machine)).not.toContain("gold-private-secret");
    expect(f.machine.attempts[0].diagnostic_visibility.items[0].visible_body).toBe(truncateForAnalyze(f.replay.items[0].body));
    expect(f.machine.attempts[0].diagnostic_visibility.items[0].omitted).toBe(true);
  });
  it("rejects omitted attempts, sources and gold fields in execution data", () => {
    const f = fixture(); expect(() => buildMachineInput(f.data, shaA, [], [])).toThrow("full_attempt_denominator_required");
    expect(() => buildMachineInput(f.data, shaA, [{ ...f.replay, items: [] }], [])).toThrow("full_source_occurrence_denominator_required");
    const withGold = { ...f.machine, gold_dimensions: ["human-important"] }; expect(() => validateMachineInput(withGold)).toThrow();
  });
  it("rejects body, visible-text and history cutoff tampering", () => {
    const f = fixture(); const machine = structuredClone(f.machine); machine.attempts[0].items[0].body += "changed";
    expect(() => validateMachineInput(machine)).toThrow("machine_body_hash_mismatch");
    const visible = structuredClone(f.machine); visible.attempts[0].diagnostic_visibility.items[0].visible_body = "substring shortcut";
    expect(() => validateMachineInput(visible)).toThrow("actual_visibility_path_mismatch");
    const cutoff = structuredClone(f.machine); cutoff.attempts[0].history_cutoff = "2026-10-03T18:00:00.000Z";
    expect(() => validateMachineInput(cutoff)).toThrow("history_cutoff_mismatch");
  });
  it("rejects a complete-looking machine bundle with swapped revision or smaller registered denominator", () => {
    const f = fixture(); const revised = structuredClone(f.machine); revised.attempts[0].occurrences[0].revision = "different-source-version";
    expect(() => assertMachineMatchesStage0(revised, f.data)).toThrow("machine_original_source_revision_mismatch");
    const reduced = structuredClone(f.machine); reduced.registered_runs = [];
    expect(() => assertMachineMatchesStage0(reduced, f.data)).toThrow("machine_registered_denominator_mismatch");
    const profile = structuredClone(f.machine); profile.attempts[0].diagnostic_visibility.body_budget_chars++;
    expect(() => validateMachineInput(profile)).toThrow("actual_visibility_profile_mismatch");
  });
  it("prepares exact C1 prompt change without injecting gold or removing shared guards", () => {
    const candidate = candidateFirstExtractionPrompt(ANALYZER_SYSTEM);
    expect(candidate).not.toBe(ANALYZER_SYSTEM); expect(candidate).toContain("唯一主 citation"); expect(candidate).toContain("金标");
    expect(candidate).toContain("同一 AnalyzerOutputSchema"); expect(candidate).toContain("quote-only");
    expect(() => candidateFirstExtractionPrompt("changed baseline")).toThrow("baseline_dedup_rule_changed_requires_review");
  });
});

describe("C1 protocol and execution preflight", () => {
  it("refuses calls without genuine freeze and exposes exact-history/interface gaps", () => {
    const f = fixture(); const result = checkExecutionPreflight(f.machineResource, f.planResource, null);
    expect(result).toMatchObject({ status: "blocked", model_calls_authorized: false, protocol_resources_verified: false });
    expect(result.blockers).toEqual(expect.arrayContaining(["t04_protocol_not_frozen", "original_model_visible_history_not_exactly_proven", "c1_shadow_prompt_interface_not_implemented_or_reviewed"]));
  });
  it("refuses a forged ready label and changed resource versions", () => {
    const f = fixture(); const fake = f.write("fake-freeze.json", { schema_version: "rich-brief-stage0-freeze-v1", frozen_at: "2026-10-01T00:00:00.000Z", resources: [], protocol: { approved: true }, readiness: { status: "ready_for_freeze", blockers: [], counts: {} }, production_enabled: false });
    expect(() => verifyFrozenProtocol(fake, shaA)).toThrow();
    expect(checkExecutionPreflight(f.machineResource, f.planResource, fake).blockers).toContain("t04_freeze_or_resource_verification_failed");
    writeFileSync(f.plan.baseline_prompt_resource.path, "modified");
    expect(checkExecutionPreflight(f.machineResource, f.planResource, null).blockers).toContain("execution_resource_changed_or_missing");
  });
});

describe("C1 independent call accounting", () => {
  it("preserves billable-unknown failures and retries as separate attempts", () => {
    const f = fixture(); const second = { ...f.entry, call_id: "call-2", retry_of: "call-1", attempt: 2, terminal: "completed", failure_reason: null, output_sha256: shaA,
      started_at: "2026-10-03T17:00:01.000Z", ended_at: "2026-10-03T17:00:02.000Z", cost: { status: "known", currency: "USD", amount_micros: "125001", evidence_resource: f.plan.ledger_contract_resource } };
    const entries = validateLedger([f.entry, second], f.arm, f.expected); const summary = summarizeLedger(entries, f.expected.registered);
    expect(summary.by_arm.C1).toMatchObject({ calls: 2, failed: 1, completed: 1, unknown_cost_calls: 1, unknown_token_calls: 2, known_usd_micros: "125001" });
    expect(summarizeLedger([], f.expected.registered)).toMatchObject({ status: "not_executed", registered_input_attempts: 1, by_arm: {} });
  });
  it("rejects rewritten failures, detached retries, cross-arm and runtime drift", () => {
    const f = fixture(); expect(() => validateLedger([f.entry, f.entry], f.arm, f.expected)).toThrow("duplicate_or_rewritten_terminal_call");
    expect(() => validateLedger([{ ...f.entry, attempt: 2, retry_of: "missing" }], f.arm, f.expected)).toThrow("ledger_retry_does_not_preserve_failed_attempt");
    expect(() => validateLedger([{ ...f.entry, arm_id: "A" }], f.arm, f.expected)).toThrow("ledger_arm_or_frozen_input_mismatch");
    expect(() => validateLedger([{ ...f.entry, model: "other" }], f.arm, f.expected)).toThrow("ledger_runtime_version_mismatch");
    expect(() => validateLedger([{ ...f.entry, cost: { status: "unknown", reason: "no receipt", amount_micros: "0" } }], f.arm, f.expected)).toThrow();
  });
});

describe("attested offline snapshot admission", () => {
  function snapshotFixture() {
    const f = fixture(), path = join(f.root, "insight.db"), db = new Database(path); db.exec("CREATE TABLE sample(value TEXT)"); db.close();
    const offline = join(f.root, "offline.db"); copyFileSync(path, offline); const dbHash = fileResource(path).sha256;
    const interval = { started_at: "2026-10-03T18:00:00.000Z", completed_at: "2026-10-03T18:00:03.000Z", source_data_version_before: 1, source_data_version_after: 1, source_data_version_unchanged: true, db_sha256: dbHash };
    const backup = f.write("backup-manifest.json", { schema_version: 1, status: "incomplete", created_at: "2026-10-03T18:01:00.000Z", files: [{ path: "insight.db", sha256: dbHash, size: readFileSync(path).length }], db_snapshot_interval: interval });
    const exported = f.write("snapshot-manifest.json", { format_version: "brief-density-s0-v2", snapshot_sha256: dbHash, as_of: interval.completed_at,
      snapshot_time_evidence: { status: "db_interval_no_external_commit_observed", backup_manifest_sha256: backup.sha256, completed_at: interval.completed_at } });
    return { ...f, config: { run_id: "run-a", db_path: offline, backup_manifest: backup, exporter_manifest: exported }, original: path, offline };
  }
  it("accepts exact attested DELETE bytes while keeping incomplete backup distinct", () => {
    const f = snapshotFixture(); expect(attestSnapshot(f.config).as_of).toBe("2026-10-03T18:00:03.000Z");
  });
  it("rejects WAL/sidecars and changed DB/manifest bytes before opening", () => {
    const f = snapshotFixture(); writeFileSync(`${f.offline}-wal`, "sidecar"); expect(() => attestSnapshot(f.config)).toThrow("standalone_snapshot_required");
    const next = snapshotFixture(); const bytes = readFileSync(next.offline); bytes[18] = 2; writeFileSync(next.offline, bytes);
    expect(() => attestSnapshot(next.config)).toThrow("delete_journal_snapshot_required");
    const changed = snapshotFixture(); writeFileSync(changed.config.backup_manifest.path, "changed"); expect(() => attestSnapshot(changed.config)).toThrow("resource_hash_mismatch");
  });
  it.each(["original", "offline"] as const)("rejects DELETE journal sidecars beside the %s DB", (location) => {
    const f = snapshotFixture(); writeFileSync(`${f[location]}-journal`, "rollback-journal");
    expect(() => attestSnapshot(f.config)).toThrow("standalone_snapshot_required");
  });
});
