/** Offline, conservative AWS wire-shape projection. No transport or authority. */
import { bindingSchema, check, parse, same } from "./contract.mjs";

export const FIXTURE_WIRE = Object.freeze({
  InstanceId: "i-00000000000000000", DocumentName: "InsightA3FixtureRecordOnly",
  DocumentVersion: "1", PluginName: "fixtureRecordOnly",
});

function json(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  check(depth <= 12 && ++budget.nodes <= 4096, "invalid_ssm_response");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { check(Number.isFinite(value), "invalid_ssm_response"); return value; }
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    check(value.length <= 32768 && budget.bytes <= 65536, "invalid_ssm_response"); return value;
  }
  check(value && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), "invalid_ssm_response");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Object.getOwnPropertySymbols(value).length === 0, "invalid_ssm_response");
  if (Array.isArray(value)) {
    check(value.length <= 256 && Object.keys(descriptors).length === value.length + 1, "invalid_ssm_response");
    return Array.from({ length: value.length }, (_, index) => {
      const field = descriptors[index];
      check(field && Object.hasOwn(field, "value") && field.enumerable, "invalid_ssm_response");
      return json(field.value, depth + 1, budget);
    });
  }
  const copy = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    budget.bytes += Buffer.byteLength(key);
    check(key.length <= 128 && budget.bytes <= 65536 && descriptor.enumerable && Object.hasOwn(descriptor, "value")
      && !["__proto__", "constructor", "prototype"].includes(key), "invalid_ssm_response");
    copy[key] = json(descriptor.value, depth + 1, budget);
  }
  return copy;
}
function object(value) { check(value && Object.getPrototypeOf(value) === Object.prototype, "invalid_ssm_response"); return value; }
function keys(value, permitted) {
  check(Object.keys(value).every(key => permitted.includes(key)), "invalid_ssm_response");
}
function context(raw, withCommand) {
  let expected;
  try { expected = parse(bindingSchema, json(raw)); } catch { throw new Error("invalid_ssm_context"); }
  check(expected.executionIdentity === "fixture-controller-v1" && expected.target.region === "isolated"
    && expected.target.instanceId === "fixture-controller-node" && expected.target.volumeId === "fixture-controller-volume"
    && expected.target.dataPath.startsWith("/") && same(expected.target.serviceSet, ["fixture-controller"])
    && expected.submitToken !== null && expected.requestHash !== null
    && (withCommand ? expected.commandId !== null : expected.commandId === null), "invalid_ssm_context");
  return expected;
}
function comment(expected) { return `a3:${expected.submitToken}:${expected.requestHash.slice(0, 56)}`; }
function document(body, expected) {
  check(body.DocumentName === FIXTURE_WIRE.DocumentName && body.DocumentVersion === FIXTURE_WIRE.DocumentVersion
    && body.Comment === comment(expected), "invalid_ssm_response");
}
const commandKeys = ["AlarmConfiguration", "CloudWatchOutputConfig", "CommandId", "Comment", "CompletedCount", "DeliveryTimedOutCount",
  "DocumentName", "DocumentVersion", "ErrorCount", "ExpiresAfter", "InstanceIds", "MaxConcurrency", "MaxErrors", "NotificationConfig",
  "OutputS3BucketName", "OutputS3KeyPrefix", "OutputS3Region", "Parameters", "RequestedDateTime", "ServiceRole", "Status", "StatusDetails",
  "TargetCount", "Targets", "TimeoutSeconds", "TriggeredAlarms"];
export function parseSendResponse(raw, rawExpected) {
  const expected = context(rawExpected, false), body = object(json(raw)); keys(body, ["Command"]);
  const command = object(body.Command); keys(command, commandKeys); document(command, expected);
  check(typeof command.CommandId === "string" && bindingSchema.shape.commandId.safeParse(command.CommandId).success
    && same(command.InstanceIds, [FIXTURE_WIRE.InstanceId])
    && (!Object.hasOwn(command, "Targets") || same(command.Targets, [])), "invalid_ssm_response");
  return { commandId: command.CommandId };
}
const invocationKeys = ["CloudWatchOutputConfig", "CommandId", "Comment", "DocumentName", "DocumentVersion", "ExecutionElapsedTime",
  "ExecutionEndDateTime", "ExecutionStartDateTime", "InstanceId", "PluginName", "ResponseCode", "StandardErrorContent", "StandardErrorUrl",
  "StandardOutputContent", "StandardOutputUrl", "Status", "StatusDetails"];
const pairs = Object.freeze({ "Pending\nPending": "Pending", "InProgress\nIn Progress": "InProgress", "Delayed\nDelayed": "Delayed",
  "Cancelling\nCancelling": "Cancelling", "Success\nSuccess": "Success", "Failed\nFailed": "Failed", "Cancelled\nCancelled": "Cancelled",
  "TimedOut\nDelivery Timed Out": "DeliveryTimedOut", "TimedOut\nExecution Timed Out": "ExecutionTimedOut" });
export function parseInvocationResponse(raw, rawExpected) {
  const expected = context(rawExpected, true), body = object(json(raw)); keys(body, invocationKeys); document(body, expected);
  check(body.CommandId === expected.commandId && body.InstanceId === FIXTURE_WIRE.InstanceId && body.PluginName === FIXTURE_WIRE.PluginName
    && typeof body.Status === "string" && typeof body.StatusDetails === "string" && Number.isSafeInteger(body.ResponseCode), "invalid_ssm_response");
  const status = pairs[`${body.Status}\n${body.StatusDetails}`];
  check(Object.hasOwn(pairs, `${body.Status}\n${body.StatusDetails}`) && (status !== "Success" || body.ResponseCode === 0)
    && (status !== "Failed" || body.ResponseCode !== 0), "invalid_ssm_response");
  return { commandId: expected.commandId, status, responseCode: body.ResponseCode };
}
export function parseCancelResponse(raw) {
  const body = json(raw);
  check(body === null || (Object.getPrototypeOf(body) === Object.prototype && Object.keys(body).length === 0), "invalid_ssm_response");
  return { acknowledgement: true };
}
