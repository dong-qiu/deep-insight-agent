import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Documentary diagnostics only. Neither claimed evidence nor A3 fixture state
// can authorize execution. The real identity verifier remains #435's preflight.
const identityFields = ["repository", "revision", "platform", "index_digest", "manifest_digest", "config_digest", "compose_sha256"];
const bindingFields = ["operation_id", "maintenance_holder", "operator", "schema_sha256", "migrations_sha256", "configuration_sha256", "data_sample_sha256"];
const hashFields = bindingFields.filter(key => key.endsWith("_sha256"));
const phases = new Set(["before-writer-stop", "writers-stopped", "backup", "migration", "deployment-record", "readiness", "rollback-readiness", "unknown"]);
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const utc = value => {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
};
const sameIdentity = (value, policy) => identityFields.every(key => object(value)[key] === policy[key]);

/** Untrusted declarations are checked for completeness/binding, never promoted to verified evidence. */
export function assessA2(input, policy, now = Date.now()) {
  const request = object(input), context = object(request.context), reasons = [];
  const phase = phases.has(request.phase) ? request.phase : "unknown";
  const add = reason => reasons.push(reason);
  if (policy?.schema_version !== "security-release-identity-v1" || policy.deployment?.status !== "blocked"
    || policy.deployment.safe_rollback !== null) throw new Error("A2 diagnostic slice requires the unchanged blocked identity policy");
  if (request.schema_version !== "a2-a3-handoff-v1") add("unknown_handoff_version");
  if (!phases.has(request.phase)) add("unknown_execution_phase");
  if (!bindingFields.every(key => typeof context[key] === "string" && context[key].trim()
    && (!hashFields.includes(key) || hash(context[key])))) add("missing_operation_or_data_binding");
  if (!sameIdentity(context.release, policy)) add("release_identity_mismatch");
  if (!sameIdentity(request.rollback, policy)) add("rollback_missing_or_outside_researched_identity");
  else add("same_image_cannot_remedy_its_own_startup_failure");

  const declarations = {};
  for (const [kind, scope, required] of [
    ["identity", "isolated-runner", ["actual_pull", "compose_binding"]],
    ["security", "isolated-runner", ["native_six", "builder_source_map_magicast", "runtime_source_map", "auth_reader_contract"]],
    ["isolated_compatibility", "synthetic", ["pre_release", "target_new_data", "post_migration", "rollback_read_update", "no_data_loss"]],
    ["production_compatibility", "current-production", ["schema", "configuration", "backup_hash_integrity", "capacity", "no_data_loss"]],
    ["approval", "scoped-authorization", ["operator", "oncall", "reviewer", "approver", "continuous_stop_accepted"]],
  ]) {
    const claim = object(object(request.evidence)[kind]);
    const binding = object(claim.binding);
    const issued = utc(claim.issued_at), expiry = utc(claim.expires_at);
    const complete = hash(claim.receipt_sha256) && claim.scope === scope && claim.result === "pass"
      && Number.isFinite(now) && issued <= now && now < expiry && issued < expiry
      && bindingFields.every(key => binding[key] === context[key] && typeof binding[key] === "string" && binding[key].trim())
      && sameIdentity(binding.release, policy) && sameIdentity(binding.rollback, policy)
      && required.every(key => object(claim.checks)[key] === true);
    declarations[kind] = { structurally_complete: Boolean(complete), verified: false };
    if (!complete) add(`${kind}_missing_stale_or_misbound`);
  }
  // A2 never attests holder/drain/SSM state and never releases maintenance.
  add("a3_protocol_and_execution_evidence_not_verified");
  add("safe_rollback_null_unapproved");
  add("declarations_are_not_authenticated_receipts");
  add("production_entry_remains_unconditionally_blocked");
  if (phase === "rollback-readiness") add("rollback_startup_failure_requires_manual_takeover");
  return {
    schema_version: "a2-diagnostic-v1", interface_version: "a2-a3-handoff-v1",
    location: "local-documentary-assessment", production_entry_integrated: false,
    deployment_permitted: false, rollback_permitted: false, approved_safe_rollback: null,
    phase, declarations, blockers: [...new Set(reasons)],
    failure_disposition: phase === "before-writer-stop" ? "abort-before-production-change" : "retain-isolation-and-manual-takeover",
    a3_obligation: phase === "before-writer-stop" ? "do-not-enter-writer-stop"
      : "verify-or-reestablish-all-writer-quiescence-and-retain-maintenance",
    database_restore_permitted: false, inverse_migration_permitted: false,
    health_is_security_acceptance: false, commands_executed: false,
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error("one documentary JSON input required");
  const input = JSON.parse(readFileSync(args[0], "utf8"));
  const policy = JSON.parse(readFileSync(new URL("./security-release-policy.json", import.meta.url), "utf8"));
  const result = assessA2(input, policy);
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); process.exitCode = 1; }
  catch { console.error("A2 documentary assessment failed; production and rollback remain blocked."); process.exitCode = 1; }
}
