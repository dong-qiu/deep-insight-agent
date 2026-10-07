import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadiness, prepareData, requiredNumbers, requiredRuntimePolicies, requiredRuntimeRoles, type FreezeProtocol, type HumanLabels } from "../rich-brief-stage0/data.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
/** Synthetic human receipts only; real stage0 freeze path exercised, never production gold. */
export function freezeFixture() {
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
    token_budget: 1, cost_budget_usd: 0.25, timeout_ms: 1, max_attempts: 1, failure_policy: "include every failed attempt", cost_accounting: "bill failures separately", stop_rule: "stop at registered limits", ledger_schema_sha256: ledger.sha256,
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
