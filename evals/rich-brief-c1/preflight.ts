import { readFileSync } from "node:fs";
import { z } from "zod";
import { checkReadiness, prepareData, type PreparedData, type FreezeProtocol } from "../rich-brief-stage0/data.js";
import { canonicalHash } from "../../src/lib/db/provenance-facts.js";
import { callLedgerContract } from "./ledger.js";
import { assertMachineMatchesStage0, validateMachineInput } from "./input.js";
import { jsonBytes, object, resourceSchema, sha, utc, verifyResource, type Resource } from "./common.js";

export const executionPlanSchema = z.object({ schema_version: z.literal("rich-brief-c1-execution-plan-v1"), status: z.literal("prepared_not_executable"),
  production_enabled: z.literal(false), c1_prompt_injection: z.literal("missing_reviewed_shadow_interface"),
  baseline: z.literal("analyze_including_filterByQuoteCoverage_then_validateBatch"),
  c1: z.literal("same_analyze_output_schema_derivation_and_common_real_gates"),
  machine_resource: resourceSchema, ledger_contract_resource: resourceSchema, baseline_prompt_resource: resourceSchema, candidate_prompt_resource: resourceSchema,
  production_code_resources: z.array(resourceSchema).min(1),
  intervention: z.literal("first_extraction_prompt_only"), human_gold_to_extractor: z.literal(false),
}).strict();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
const frozenSchema = z.object({ schema_version: z.literal("rich-brief-stage0-freeze-v1"), frozen_at: utc, resources: z.array(resourceSchema).min(3), protocol: z.unknown(),
  readiness: z.object({ status: z.literal("ready_for_freeze"), blockers: z.array(z.string()).length(0), counts: z.unknown() }).strict(), production_enabled: z.literal(false) }).strict();

/** Reconstruct and revalidate the existing freeze procedure, rather than trusting a 'ready' label. */
export function verifyFrozenProtocol(frozenResource: Resource, machineUpstreamSha256: string, now = new Date().toISOString()): { protocol: FreezeProtocol; resources: Resource[]; upstream_data: PreparedData } {
  verifyResource(frozenResource);
  const frozen = frozenSchema.parse(JSON.parse(readFileSync(frozenResource.path, "utf8")));
  if (frozen.frozen_at > utc.parse(now)) throw new Error("freeze_time_in_future");
  for (const resource of frozen.resources) verifyResource(resource);
  const [inputResource, labelsResource, protocolResource] = frozen.resources;
  if (inputResource.sha256 !== machineUpstreamSha256) throw new Error("frozen_input_mismatch");
  const data = JSON.parse(readFileSync(inputResource.path, "utf8")) as PreparedData;
  const labels = JSON.parse(readFileSync(labelsResource.path, "utf8"));
  const protocol = JSON.parse(readFileSync(protocolResource.path, "utf8")) as FreezeProtocol;
  if (canonicalHash(protocol) !== canonicalHash(frozen.protocol)) throw new Error("frozen_protocol_payload_mismatch");
  const configResource = data.resources.at(-1); if (!configResource) throw new Error("frozen_preparation_config_missing");
  verifyResource(configResource);
  const regenerated = prepareData(JSON.parse(readFileSync(configResource.path, "utf8"))); regenerated.resources.push(configResource);
  if (sha(jsonBytes(regenerated)) !== inputResource.sha256) throw new Error("frozen_input_not_original_export_reconstruction");
  const readiness = checkReadiness(data, inputResource.sha256, labels, protocol, frozen.frozen_at, labelsResource.sha256);
  if (readiness.status !== "ready_for_freeze" || canonicalHash(readiness) !== canonicalHash(frozen.readiness)) throw new Error("frozen_protocol_did_not_pass_stage0_gate");
  for (const resource of [...data.resources, ...protocol.resources]) if (!frozen.resources.some((entry) => entry.path === resource.path && entry.sha256 === resource.sha256)) throw new Error("freeze_omitted_bound_resource");
  return { protocol, resources: frozen.resources, upstream_data: data };
}

export function checkExecutionPreflight(machineResource: Resource, planResource: Resource, frozenResource: Resource | null) {
  const blockers = new Set<string>();
  verifyResource(machineResource); verifyResource(planResource);
  const machine = validateMachineInput(JSON.parse(readFileSync(machineResource.path, "utf8")));
  const plan = executionPlanSchema.parse(JSON.parse(readFileSync(planResource.path, "utf8")));
  if (plan.machine_resource.path !== machineResource.path || plan.machine_resource.sha256 !== machineResource.sha256) blockers.add("execution_plan_machine_resource_mismatch");
  for (const resource of [...machine.resources, ...machine.attempts.flatMap((a) => a.snapshot_resources), ...plan.production_code_resources,
    plan.machine_resource, plan.ledger_contract_resource, plan.baseline_prompt_resource, plan.candidate_prompt_resource]) {
    try { verifyResource(resource); } catch { blockers.add("execution_resource_changed_or_missing"); }
  }
  if (plan.ledger_contract_resource.sha256 !== sha(jsonBytes(callLedgerContract))) blockers.add("ledger_contract_version_mismatch");
  if (machine.registered_runs.some((run) => run.status !== "observed")) blockers.add("registered_run_observability_unknown");
  if (machine.attempts.some((attempt) => attempt.history.status !== "exact_runtime_proven")) blockers.add("original_model_visible_history_not_exactly_proven");
  blockers.add("visible_profile_requires_frozen_runtime_resolution");
  blockers.add("c1_shadow_prompt_interface_not_implemented_or_reviewed");
  let protocolVerified = false;
  if (!frozenResource) blockers.add("t04_protocol_not_frozen");
  else {
    try {
      const frozen = verifyFrozenProtocol(frozenResource, machine.upstream_input_sha256);
      assertMachineMatchesStage0(machine, frozen.upstream_data);
      const bound = (r: Resource) => frozen.protocol.resources.some((entry) => entry.path === r.path && entry.sha256 === r.sha256);
      for (const resource of [machineResource, planResource, plan.ledger_contract_resource, plan.baseline_prompt_resource, plan.candidate_prompt_resource, ...machine.resources,
        ...machine.attempts.flatMap((a) => a.snapshot_resources), ...plan.production_code_resources]) if (!bound(resource)) blockers.add("execution_resources_not_in_frozen_protocol");
      const baseline = frozen.protocol.arms.filter((a) => a.task === "baseline"), c1 = frozen.protocol.arms.filter((a) => a.task === "first_extraction");
      if (baseline.length !== 1 || c1.length !== 1) blockers.add("exact_baseline_c1_pair_required");
      for (const arm of [...baseline, ...c1]) if (arm.ledger_schema_sha256 !== plan.ledger_contract_resource.sha256) blockers.add("arm_ledger_schema_not_frozen_contract");
      if (baseline[0]?.prompt_sha256 !== plan.baseline_prompt_resource.sha256 || c1[0]?.prompt_sha256 !== plan.candidate_prompt_resource.sha256) blockers.add("arm_prompt_not_exact_prepared_text");
      protocolVerified = true;
    } catch { blockers.add("t04_freeze_or_resource_verification_failed"); }
  }
  return { status: "blocked" as const, execution_scope: "shadow" as const, protocol_resources_verified: protocolVerified, model_calls_authorized: false,
    blockers: [...blockers].sort(), counts: { registered_runs: machine.registered_runs.length, attempts: machine.attempts.length, occurrences: machine.attempts.reduce((n, a) => n + a.occurrences.length, 0),
      revisions: new Set(machine.attempts.flatMap((a) => a.occurrences.map((o) => `${o.content_item_id}\0${o.revision}`))).size, formal_holdout: 0 } };
}

/** Narrow metadata check usable without opening a model provider. */
export function freezeManifestLooksPending(raw: unknown): boolean {
  try { const value = object(raw); return !frozenSchema.safeParse(value).success; } catch { return true; }
}
