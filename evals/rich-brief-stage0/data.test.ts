import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkReadiness, exposurePartition, freezeData, pendingLabels, prepareData, privateWrite, requiredNumbers, requiredRuntimePolicies, requiredRuntimeRoles, type FreezeProtocol, type HumanLabels } from "./data.js";
import { renderReviewWorksheet } from "./data-review.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rich-brief-data-"))); mkdirSync(join(root, ".git"));
  const write = (name: string, value: unknown) => { const path = join(root, name); writeFileSync(path, bytes(value), { mode: 0o600 }); return { path, sha256: hash(readFileSync(path)) }; };
  const sourceRef = { type: "content_item", locator: { kind: "id", id: "source-a" }, revision: "content-v4:fixture", role: "input" };
  const body = "A supported change with a necessary version constraint.";
  const partition = { source_versions: [{ content_item_id: "source-a", revision: sourceRef.revision, partition: "exploration", source_unit_ids: ["unit-a"], known_family_components: ["component-a"] }],
    known_family_components: [{ split_component_id: "component-a", source_unit_ids: ["unit-a"] }], known_family_edges: [], formal_holdout: [] };
  const legacyPartition = write("partition.json", partition), legacyLabels = write("legacy-labels.json", { events: [] });
  const exportDir = join(root, "export"); mkdirSync(exportDir);
  const pool = { kind: "batch", batch: { id: "batch-a", topic_id: "t_code_agents", time_window: JSON.stringify({ end: "2026-10-03T17:00:05.000Z" }) },
    analysis_links: [{ started: { trace_id: "trace-a", attempt: 1, occurred_at: "2026-10-03T17:00:05.000Z", input_refs: JSON.stringify([sourceRef]) } }],
    input_evidence: [{ ref: sourceRef, body, body_sha256: hash(body), snapshot: { title: "A source", url: "https://example.test/a", body_kind: "article" }, gaps: [] }], candidates: [{}] };
  writeFileSync(join(exportDir, "candidate-pool.jsonl"), JSON.stringify(pool) + "\n");
  writeFileSync(join(exportDir, "stage-loss.json"), "{}\n");
  const manifest = { format_version: "brief-density-s0-v2", topics: ["t_code_agents"], window: { from_inclusive: "2026-10-03T16:50:00.000Z", until_exclusive: "2026-10-03T18:00:00.000Z" },
    as_of: "2026-10-03T18:00:03.000Z", snapshot_time_evidence: { status: "db_interval_no_external_commit_observed", completed_at: "2026-10-03T18:00:03.000Z" },
    artifact_hashes: { "candidate-pool.jsonl": hash(readFileSync(join(exportDir, "candidate-pool.jsonl"))), "stage-loss.json": hash(readFileSync(join(exportDir, "stage-loss.json"))) } };
  writeFileSync(join(exportDir, "snapshot-manifest.json"), bytes(manifest));
  const config = { topic: "t_code_agents", reader_goal: "Tool adoption and testing conditions", legacy_partition: legacyPartition, legacy_labels: legacyLabels,
    runs: [{ run_id: "run-a", scheduled_at: "2026-10-03T17:00:00.000Z", export_dir: exportDir }] };
  const configResource = write("config.json", config);
  const data = prepareData(config); data.resources.push(configResource);
  const input = write("input.json", data);
  const receipt = write("human-receipt.json", { kind: "human", note: "Synthetic test receipt; never real gold." });
  const review = { kind: "human" as const, reviewer: "synthetic-human-fixture", reviewed_at: "2026-10-06T12:00:00.000Z", receipt_path: receipt.path, receipt_sha256: receipt.sha256 };
  const occurrence = data.occurrences[0];
  const labels: HumanLabels = { schema_version: "rich-brief-stage0-labels-v1", input_sha256: input.sha256, review,
    sources: [{ occurrence_id: occurrence.occurrence_id, status: "complete", event_ids: ["event-a"], no_in_scope_event_reason: "", family_status: "reviewed" }],
    events: [{ event_id: "event-a", identity: { subject: "A", action: "released", object_version: "v1", time: "2026-10-03" }, importance: "important", importance_reason: "Affects tool adoption",
      dimensions: [{ dimension_id: "dimension-a", claim: "A supported change", importance: "must", evidence: [{ occurrence_id: occurrence.occurrence_id, start: 0, end: 18, quote: body.slice(0, 18) }], necessary_qualifiers: ["v1"], qualifier_review: "complete", distinctness_reason: "Main change" }],
      questions: [{ question_id: "question-a", question: "What changed?", answer: "A supported change", dimension_ids: ["dimension-a"] }], inherited_label_refs: [] }] };
  const labelsResource = write("labels.json", labels);
  const prompt = write("prompt.json", { version: "synthetic-test-prompt" }), ledger = write("ledger.json", { version: "synthetic-test-ledger" });
  const modelResources = Object.fromEntries(["test-model", "test-validator", "test-countercheck"].map((model) => [model,
    write(`${model}.json`, { schema_version: "rich-brief-runtime-model-v1", model, model_revision: "test-revision" })]));
  const providerResource = write("provider.json", { schema_version: "rich-brief-runtime-provider-v1", provider: "test-provider", transport_revision: "test-transport-v1" });
  const policyResource = write("runtime-policy.json", { schema_version: "synthetic-runtime-policy-v1", meaning: "test fixture only" });
  const runtimeRoles: FreezeProtocol["arms"][number]["runtime_roles"] = requiredRuntimeRoles.map((role) => {
    const model = ["extractor", "reader_language_repair"].includes(role) ? "test-model" : role === "quote_only_countercheck" ? "test-countercheck" : "test-validator";
    return { role, model, model_revision: "test-revision", provider: "test-provider", transport_revision: "test-transport-v1", model_resource: modelResources[model], provider_resource: providerResource,
      prompt_resource: prompt, policy_resource: policyResource, max_output_tokens: 1,
      cache: { status: "known", mode: "off", namespace: null, snapshot: null, policy_resource: policyResource },
      thinking: { status: "known", enabled: false, budget_tokens: 0, source: "test-explicit-off", transport_revision: "test-disabled-v1", policy_resource: policyResource } };
  });
  const runtimePolicies = Object.fromEntries(requiredRuntimePolicies.map((name) => [name, policyResource]));
  const numbers = Object.fromEntries(requiredNumbers.map((name) => [name, { value: name.endsWith("_delta") || name === "max_unknown_ratio" || name === "max_failure_ratio" ? 0 : name === "min_gain_ratio" ? 0.1 : 1,
    rationale: "Synthetic test value, not production threshold", evidence_resource_sha256: receipt.sha256, approval: review }]));
  const baseArm = { input_sha256: input.sha256, model: "test-model", provider: "test-provider", model_revision: "test-revision", prompt_sha256: prompt.sha256,
    token_budget: 1, cost_budget_usd: 1, timeout_ms: 1, max_attempts: 1, failure_policy: "include every failed attempt", cost_accounting: "bill failures separately", stop_rule: "stop at registered limits", ledger_schema_sha256: ledger.sha256,
    runtime_roles: runtimeRoles, runtime_policies: runtimePolicies };
  const protocol: FreezeProtocol = { schema_version: "rich-brief-stage0-protocol-v1", topic: "t_code_agents", input_sha256: input.sha256, labels_sha256: labelsResource.sha256,
    review, resources: [receipt, prompt, ledger, ...Object.values(modelResources), providerResource, policyResource], numbers,
    arms: [{ ...structuredClone(baseArm), arm_id: "A", task: "baseline" }, { ...structuredClone(baseArm), arm_id: "C1", task: "first_extraction" }],
    source_family_policy: "connected_exposure_excluded_unknown_quarantined", gold_visibility: "scorer_only_not_extractor",
    holdout: { status: "unseen_prospective_uncollected", starts_at: "2099-10-08T17:00:00.000Z", ends_at: "2099-10-09T17:00:00.000Z", registered_run_ids: ["future-run-a"],
      all_scheduled_runs_and_attempts: true, source_family_audit_before_score: true, opened_at: null, formal_results_seen: false, attestation: review },
    safety: { unsupported_assertions: 0, wrong_event_merges: 0, missing_necessary_qualifiers: 0, blocked_or_unvalidated_citations: 0, unsafe_accept: 0 }, production_enabled: false, b1_status: "no_go" };
  const protocolResource = write("protocol.json", protocol);
  const check = (overrideLabels: unknown = labels, overrideProtocol: unknown = protocol) => checkReadiness(data, input.sha256, overrideLabels, overrideProtocol, "2026-10-07T12:00:00.000Z");
  return { root, write, data, input, labels, labelsResource, protocol, protocolResource, config, manifest, exportDir, pool, partition, receipt, check };
}

describe("stage 0 full-input preparation", () => {
  it("preserves an unobservable registered run in the run denominator", () => {
    const f = fixture(); const data = prepareData({ ...f.config, runs: [...f.config.runs, { run_id: "missing", scheduled_at: "2026-10-04T17:00:00.000Z", export_dir: null }] });
    expect(data.runs).toHaveLength(2); expect(data.runs[1].status).toBe("unknown");
    expect(checkReadiness(data, f.input.sha256, f.labels, {}).blockers).toContain("complete_run_input_denominator_unknown");
  });
  it("keeps a failed no-batch attempt and unknown total rather than zero", () => {
    const f = fixture(); const failed = { ...f.pool, kind: "trace_without_batch", topic_id: "t_code_agents", started: { ...f.pool.analysis_links[0].started, trace_id: "failed-trace" }, candidates: null };
    const poolText = JSON.stringify(f.pool) + "\n" + JSON.stringify(failed) + "\n";
    writeFileSync(join(f.exportDir, "candidate-pool.jsonl"), poolText);
    writeFileSync(join(f.exportDir, "snapshot-manifest.json"), bytes({ ...f.manifest, artifact_hashes: { ...f.manifest.artifact_hashes, "candidate-pool.jsonl": hash(poolText) } }));
    const data = prepareData(f.config);
    expect(data.attempts).toHaveLength(2); expect(data.occurrences).toHaveLength(2);
    expect(data.attempts[1]).toMatchObject({ total_candidates: "unknown", observed_candidates: 0, cutoff: "unknown" });
  });
  it("requires exact artifact bytes and refuses duplicate scheduling", () => {
    const f = fixture(); writeFileSync(join(f.exportDir, "stage-loss.json"), "changed");
    expect(() => prepareData(f.config)).toThrow("export_artifact_hash_mismatch");
    expect(() => prepareData({ ...f.config, runs: [...f.config.runs, ...f.config.runs] })).toThrow("duplicate_registered_run");
  });
  it("does not hide an unlinked record behind another observed attempt", () => {
    const f = fixture(); const poolText = JSON.stringify(f.pool) + "\n" + JSON.stringify({ ...f.pool, analysis_links: [] }) + "\n";
    writeFileSync(join(f.exportDir, "candidate-pool.jsonl"), poolText);
    writeFileSync(join(f.exportDir, "snapshot-manifest.json"), bytes({ ...f.manifest, artifact_hashes: { ...f.manifest.artifact_hashes, "candidate-pool.jsonl": hash(poolText) } }));
    const data = prepareData(f.config); expect(data.runs[0].status).toBe("unknown");
    expect(checkReadiness(data, f.input.sha256, f.labels, f.protocol).blockers).toContain("complete_run_input_denominator_unknown");
  });
  it("uses connected known families and rejects exposed formal holdout", () => {
    const f = fixture(); const partition = { ...f.partition, source_versions: [...f.partition.source_versions,
      { ...f.partition.source_versions[0], content_item_id: "source-b", source_unit_ids: ["unit-b"], known_family_components: ["component-b"] }],
      known_family_edges: [{ left: "unit-a", right: "unit-b", reason: "same study" }] };
    const exposure = exposurePartition(partition);
    expect(new Set(Object.values(exposure.component_by_source)).size).toBe(1);
    expect(exposure.semantic_family_completeness).toBe("unknown");
    expect(() => exposurePartition({ ...partition, formal_holdout: ["old-source"] })).toThrow("old_exposure_cannot_be_formal_holdout");
    expect(() => exposurePartition({ ...partition, known_family_edges: [{ left: "unit-a", right: "not-in-inventory" }] })).toThrow("unresolved_known_family_edge");
  });
});

describe("stage 0 fail-closed freeze", () => {
  it("has a ready synthetic control and can freeze exact resources", () => {
    const f = fixture(); expect(f.check()).toMatchObject({ status: "ready_for_freeze", blockers: [] });
    const output = join(f.root, ".data", "rich-brief-stage0", "frozen");
    expect(freezeData(f.root, f.input.path, f.labelsResource.path, f.protocolResource.path, output).sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps human gold pending and refuses AI confirmation", () => {
    const f = fixture(); expect(f.check(pendingLabels(f.data, f.input.sha256)).blockers).toContain("human_gold_not_confirmed");
    expect(f.check({ ...f.labels, review: { ...f.labels.review, kind: "ai" } }).blockers).toContain("human_labels_schema_invalid");
  });
  it("does not create a freeze artifact when human gold is pending", () => {
    const f = fixture(); const pending = f.write("pending-labels.json", pendingLabels(f.data, f.input.sha256));
    const protocol = f.write("pending-protocol.json", { ...f.protocol, labels_sha256: pending.sha256 });
    expect(() => freezeData(f.root, f.input.path, pending.path, protocol.path, join(f.root, ".data", "rich-brief-stage0", "pending-freeze"))).toThrow("freeze_blocked:");
  });
  it("rejects missing full-input gold, unsupported spans, and incorrect question bindings", () => {
    const f = fixture(); expect(f.check({ ...f.labels, sources: [] }).blockers).toContain("full_input_gold_coverage_mismatch");
    const labels = structuredClone(f.labels); labels.events[0].dimensions[0].evidence[0].quote = "unsupported";
    labels.events[0].questions[0].dimension_ids = ["other-event-dimension"];
    const blockers = f.check(labels).blockers;
    expect(blockers).toContain("gold_evidence_span_mismatch"); expect(blockers).toContain("reading_question_dimension_mismatch");
  });
  it("rejects omitted numeric decisions and thresholds without a bound rationale", () => {
    const f = fixture(); const p = structuredClone(f.protocol); delete p.numbers.min_gain_ratio;
    expect(f.check(f.labels, p).blockers).toContain("required_numeric_protocol_incomplete");
    p.numbers = structuredClone(f.protocol.numbers); p.numbers.min_gain_ratio.evidence_resource_sha256 = "a".repeat(64);
    expect(f.check(f.labels, p).blockers).toContain("numeric_basis_not_bound_to_resource");
    p.numbers.min_gain_ratio.value = 0; p.numbers.min_key_event_recall_delta.value = -0.1;
    expect(f.check(f.labels, p).blockers).toContain("positive_gain_and_cost_budget_required");
    expect(f.check(f.labels, p).blockers).toContain("noninferiority_cannot_allow_regression");
  });
  it("rejects seen holdout, past collection, mismatched model/budget and unbound prompts", () => {
    const f = fixture(); const p = structuredClone(f.protocol); p.holdout.starts_at = "2026-10-06T00:00:00.000Z";
    p.arms[1].model = "different"; p.arms[1].prompt_sha256 = "b".repeat(64);
    expect(f.check(f.labels, p).blockers).toEqual(expect.arrayContaining(["formal_holdout_must_start_after_freeze", "baseline_c1_model_input_or_budget_unpaired", "arm_input_prompt_or_ledger_not_bound"]));
    expect(f.check(f.labels, { ...p, holdout: { ...p.holdout, formal_results_seen: true } }).blockers).toContain("t04_protocol_schema_or_numeric_decisions_pending");
  });
  it("rechecks mutable resources and refuses input that omits an occurrence", () => {
    const f = fixture(); const altered = { ...f.data, occurrences: [] }; const badInput = f.write("bad-input.json", altered);
    expect(() => freezeData(f.root, badInput.path, f.labelsResource.path, f.protocolResource.path, join(f.root, ".data", "rich-brief-stage0", "bad"))).toThrow("prepared_input_does_not_match_original_export_resources");
    writeFileSync(f.receipt.path, "changed");
    expect(f.check().blockers).toContain("protocol_resource_changed_or_missing");
  });
  it("refuses publication admission and B1 revival through protocol fields", () => {
    const f = fixture(); expect(f.check(f.labels, { ...f.protocol, production_enabled: true }).status).toBe("blocked");
    expect(f.check(f.labels, { ...f.protocol, b1_status: "approved" }).status).toBe("blocked");
  });
  it("rejects missing runtime roles and missing cache/thinking state", () => {
    const f = fixture(); const p = structuredClone(f.protocol);
    p.arms[1].runtime_roles = p.arms[1].runtime_roles.filter((r) => r.role !== "quote_only_countercheck");
    expect(f.check(f.labels, p).blockers).toContain("required_runtime_role_manifest_incomplete_or_duplicate");
    const missingCache = structuredClone(f.protocol) as unknown as { arms: { runtime_roles: Record<string, unknown>[] }[] };
    delete missingCache.arms[1].runtime_roles[0].cache;
    expect(f.check(f.labels, missingCache).blockers).toContain("t04_protocol_schema_or_numeric_decisions_pending");
    const missingThinking = structuredClone(f.protocol) as unknown as { arms: { runtime_roles: Record<string, unknown>[] }[] };
    delete missingThinking.arms[1].runtime_roles[0].thinking;
    expect(f.check(f.labels, missingThinking).status).toBe("blocked");
  });
  it("rejects non-extraction runtime drift and model separation violations", () => {
    const f = fixture(); const p = structuredClone(f.protocol);
    p.arms[1].runtime_roles.find((r) => r.role === "display_primary")!.max_output_tokens = 2;
    expect(f.check(f.labels, p).blockers).toContain("baseline_c1_non_extraction_runtime_unpaired");
    const countercheck = p.arms[1].runtime_roles.find((r) => r.role === "quote_only_countercheck")!;
    countercheck.model = "test-validator";
    expect(f.check(f.labels, p).blockers).toContain("runtime_model_separation_failed");
    expect(f.check(f.labels, p).blockers).toContain("runtime_model_resource_identity_mismatch");
  });
  it("requires role resource paths and global policies, not merely matching hashes", () => {
    const f = fixture(); const p = structuredClone(f.protocol);
    p.arms[1].runtime_roles[0].prompt_resource.path = join(f.root, "not-the-prompt.txt");
    delete p.arms[1].runtime_policies.history_selection;
    expect(f.check(f.labels, p).blockers).toContain("runtime_role_path_hash_not_bound");
    expect(f.check(f.labels, p).blockers).toContain("required_runtime_policy_manifest_incomplete");
  });
  it("requires frozen cache read state and coherent thinking budget", () => {
    const f = fixture(); const p = structuredClone(f.protocol); const policyResource = p.arms[1].runtime_roles[0].policy_resource;
    p.arms[1].runtime_roles[0].cache = { status: "known", mode: "read_write", namespace: "isolated-test-cache", snapshot: null, policy_resource: policyResource };
    p.arms[1].runtime_roles[0].thinking = { status: "known", enabled: true, budget_tokens: 0, source: "test", transport_revision: "test", policy_resource: policyResource };
    expect(f.check(f.labels, p).blockers).toEqual(expect.arrayContaining(["cache_read_state_not_frozen", "thinking_budget_inconsistent_with_enabled_state"]));
  });
});

describe("private review outputs", () => {
  it("uses protected private paths, refuses overwrite and symlinks", () => {
    const f = fixture(); const output = join(f.root, ".data", "rich-brief-stage0", "review");
    privateWrite(f.root, output, { "review.json": { ok: true } });
    expect(() => privateWrite(f.root, output, { "review.json": {} })).toThrow("new_private_stage0_output_required");
    expect(() => privateWrite(f.root, join(f.root, "public"), {})).toThrow("new_private_stage0_output_required");
    const other = realpathSync(mkdtempSync(join(tmpdir(), "rich-brief-symlink-"))); mkdirSync(join(other, ".git")); symlinkSync(join(f.root, ".data"), join(other, ".data"));
    expect(() => privateWrite(other, join(other, ".data", "rich-brief-stage0", "escape"), {})).toThrow("private_output_symlink_forbidden");
  });
  it("includes every occurrence in a local worksheet and leaves human decisions blank", () => {
    const f = fixture(); const worksheet = renderReviewWorksheet(f.data, { events: [] });
    expect(worksheet).toContain(f.data.occurrences[0].occurrence_id); expect(worksheet).toContain(f.data.occurrences[0].body);
    expect(worksheet).toContain("正式留出为 0"); expect(worksheet).toContain("待填");
  });
});
