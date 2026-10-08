/** One offline event against the actual isolated S0 ledger. No remote execution. */
import { bindingFor, canonical, check, hash, parse, same, terminalSchema, tokenFor, tokenSchema } from "./contract.mjs";
import { openLedger } from "./ledger.mjs";
import { parseCancelResponse, parseInvocationResponse, parseSendResponse } from "./ssm-response.mjs";

const actions = ["stage-submit", "receive-send", "receive-invocation", "stage-cancel", "receive-cancel", "interrupt", "resume"];
const responses = ["receive-send", "receive-invocation", "receive-cancel"];
const commandHash = hash(canonical({ schema: "a3-fixture-controller-payload-v1", execution: "record-only" }));
const primaryCodes = new Set(["maintenance_owner_lost", "maintenance_revision_conflict", "maintenance_response_mismatch", "maintenance_command_conflict",
  "maintenance_command_missing", "maintenance_terminal_conflict", "maintenance_submission_already_started", "invalid_maintenance_transition",
  "unsafe_maintenance_path", "noncanonical_maintenance_root", "maintenance_file_replaced", "maintenance_marker_changed", "unexpected_maintenance_sidecar",
  "maintenance_record_too_large", "invalid_maintenance_record", "maintenance_target_mismatch", "maintenance_audit_corrupt", "maintenance_genesis_mismatch",
  "maintenance_snapshot_invalid", "invalid_maintenance_schema", "invalid_maintenance_version", "invalid_maintenance_journal", "maintenance_genesis_missing",
  "maintenance_active_corrupt", "maintenance_fence_corrupt", "maintenance_operation_corrupt", "maintenance_submission_corrupt", "maintenance_terminal_missing"]);
function primary(error) { return error instanceof Error && primaryCodes.has(error.message) ? error.message : "controller_ledger_failed"; }
function ownObject(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0, "invalid_controller_input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Object.keys(descriptors).every(key => keys.includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value")), "invalid_controller_input");
}
function tokenCopy(raw) {
  ownObject(raw, ["operationId", "ownerId", "fence", "revision", "target", "executionIdentity"]);
  ownObject(raw.target, ["region", "instanceId", "volumeId", "dataPath", "serviceSet"]);
  const set = raw.target.serviceSet;
  check(Array.isArray(set) && set.length <= 16 && Object.getOwnPropertySymbols(set).length === 0, "invalid_controller_input");
  const fields = Object.getOwnPropertyDescriptors(set);
  check(Object.keys(fields).length === set.length + 1 && Array.from({ length: set.length }, (_, i) => fields[i] && Object.hasOwn(fields[i], "value")
    && fields[i].enumerable && typeof fields[i].value === "string").every(Boolean), "invalid_controller_input");
  check([raw.operationId, raw.ownerId, raw.executionIdentity, ...Object.values(raw.target).filter(value => typeof value === "string")].every(value => typeof value === "string" && value.length <= 4096), "invalid_controller_input");
  let token; try { token = parse(tokenSchema, raw); } catch { throw new Error("invalid_controller_input"); }
  Object.freeze(token.target.serviceSet); Object.freeze(token.target); return Object.freeze(token);
}
function inputCopy(action, raw) {
  check(actions.includes(action), "invalid_controller_input"); ownObject(raw, ["schema", "token", "event"]);
  check(raw.schema === "a3-ssm-controller-v1", "invalid_controller_input");
  const token = tokenCopy(raw.token), needsEvent = responses.includes(action);
  check(needsEvent === Object.hasOwn(raw, "event"), "invalid_controller_input");
  if (!needsEvent) return { token };
  ownObject(raw.event, ["outcome", "body"]);
  check(raw.event.outcome === "response" ? Object.hasOwn(raw.event, "body") : raw.event.outcome === "unavailable" && !Object.hasOwn(raw.event, "body"), "invalid_controller_input");
  return { token, event: { outcome: raw.event.outcome, body: raw.event.body } };
}
function profile(root, snapshot, token) {
  const target = { region: "isolated", instanceId: "fixture-controller-node", volumeId: "fixture-controller-volume", dataPath: root, serviceSet: ["fixture-controller"] };
  check(same(snapshot.marker.target, target) && same(token.target, target) && token.executionIdentity === "fixture-controller-v1", "invalid_controller_input");
  const op = snapshot.operations[token.operationId];
  check(op && snapshot.active === token.operationId && op.disposition !== "released"
    && same({ ...tokenFor(op), revision: 0 }, { ...token, revision: 0 }), "maintenance_owner_lost");
  check(op.revision === token.revision, "maintenance_revision_conflict");
  return op;
}
function phase(action, op) {
  if (action === "stage-submit") check(op.state === "pre_submit" && op.disposition === "active", "invalid_maintenance_transition");
  if (action === "receive-send") check(op.state === "submission_unknown", "invalid_maintenance_transition");
  if (action === "receive-invocation") check(op.commandId !== null && ["submitted", "running", "cancel_requested", "terminal_pending", "terminal_verified"].includes(op.state), "invalid_maintenance_transition");
  if (action === "stage-cancel") check(op.disposition === "active" && ["submitted", "running"].includes(op.state), "invalid_maintenance_transition");
  if (action === "receive-cancel") check(op.state === "cancel_requested", "invalid_maintenance_transition");
}
export function runControllerStep(root, action, raw) {
  const { token, event } = inputCopy(action, raw);
  let ledger;
  try { ledger = openLedger(root); } catch (error) { throw new Error(primary(error)); }
  try {
    let op;
    try { op = profile(root, ledger.inspect(), token); phase(action, op); } catch (error) {
      throw new Error(error instanceof Error && error.message === "invalid_controller_input" ? error.message : primary(error));
    }
    const result = { schema: "a3-ssm-controller-v1", production_permitted: false, ready: false, termination: "unknown", outcome: "recorded",
      token: null, hold: "not_attempted", commandId: op.commandId, observedStatus: null, reason: null };
    function blocked(reason) { result.outcome = "blocked"; result.token = null; result.reason = reason; return result; }
    function strictHold(reason) {
      result.hold = "unconfirmed";
      const held = ledger.hold(token, reason); result.hold = "recorded";
      return held.revision === token.revision ? token : held;
    }
    let facts;
    if (responses.includes(action)) {
      try {
        check(event.outcome === "response", "ssm_response_unavailable");
        facts = action === "receive-send" ? parseSendResponse(event.body, bindingFor(op))
          : action === "receive-invocation" ? parseInvocationResponse(event.body, bindingFor(op)) : parseCancelResponse(event.body);
      } catch {
        const reason = event.outcome === "unavailable" ? "ssm_response_unavailable" : "ssm_response_invalid";
        blocked(reason);
        try { result.token = strictHold(reason); } catch { /* Preserve the wire primary cause, without retry or refreshed authority. */ }
        return result;
      }
    }
    try {
      if (action === "stage-submit") result.token = ledger.beginSubmit(token, commandHash);
      else if (action === "stage-cancel") result.token = ledger.cancel(token);
      else if (action === "interrupt" || action === "resume" || action === "receive-cancel") {
        result.token = strictHold(action === "interrupt" ? "controller_interrupted" : action === "resume" ? "controller_restart_unknown" : "ssm_cancel_not_termination");
      } else if (action === "receive-send") {
        ledger.bindCommand(token, { ...bindingFor(op), commandId: facts.commandId });
        result.outcome = "accepted_or_replay"; result.commandId = facts.commandId;
      } else {
        const ingress = terminalSchema.safeParse(facts.status).success ? strictHold("ssm_terminal_unverified") : token;
        ledger.observe(ingress, { ...bindingFor(op), status: facts.status });
        result.outcome = "accepted_or_replay"; result.observedStatus = facts.status;
      }
      return result;
    } catch (error) { return blocked(primary(error)); }
  } finally {
    // A close diagnostic cannot overwrite an already-known CAS/COMMIT fact or primary failure.
    try { ledger.close(); } catch { /* No follow-on mutation. */ }
  }
}
