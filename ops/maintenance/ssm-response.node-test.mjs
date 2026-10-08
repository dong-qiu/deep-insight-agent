import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { FIXTURE_WIRE, parseSendResponse, parseInvocationResponse, parseCancelResponse } from "./ssm-response.mjs";

const context = { operationId: "op-parser", ownerId: "parser-owner", fence: 1,
  target: { region: "isolated", instanceId: "fixture-controller-node", volumeId: "fixture-controller-volume", dataPath: "/isolated-fixture", serviceSet: ["fixture-controller"] },
  executionIdentity: "fixture-controller-v1", commandId: null, submitToken: randomUUID(), requestHash: "a".repeat(64) };
const comment = `a3:${context.submitToken}:${context.requestHash.slice(0, 56)}`;
const commandId = randomUUID(), commandContext = { ...context, commandId };
const send = () => ({ Command: { CommandId: commandId, InstanceIds: [FIXTURE_WIRE.InstanceId], DocumentName: FIXTURE_WIRE.DocumentName,
  DocumentVersion: "1", Comment: comment, Status: "Success", Targets: [], Parameters: { unused: ["sensitive-fixture-output"] } } });
const invocation = () => ({ ...FIXTURE_WIRE, CommandId: commandId, Comment: comment, Status: "Success", StatusDetails: "Success", ResponseCode: 0,
  StandardOutputContent: "sensitive-fixture-output", StandardErrorContent: "sensitive-fixture-error", StandardOutputUrl: "https://fixture.invalid/private" });

test("send projects one UUID; aggregate success and documented unused fields carry no authority", () => {
  assert.deepEqual(parseSendResponse(send(), context), { commandId });
  assert.equal(comment.length, 96); assert.ok(Object.isFrozen(FIXTURE_WIRE));
  assert.throws(() => { FIXTURE_WIRE.InstanceId = "i-11111111111111111"; }, TypeError);
});
test("send rejects wrong/missing identities, duplicate nodes, tag targets and extra outer fields", () => {
  for (const delta of [{ CommandId: "not-uuid" }, { InstanceIds: [] }, { InstanceIds: [FIXTURE_WIRE.InstanceId, FIXTURE_WIRE.InstanceId] },
    { Targets: [{ Key: "tag:Name", Values: ["fixture"] }] }, { DocumentName: "AWS-RunShellScript" }, { DocumentVersion: "$LATEST" }, { Comment: "wrong" }]) {
    assert.throws(() => parseSendResponse({ Command: { ...send().Command, ...delta } }, context), /invalid_ssm_response/);
  }
  assert.throws(() => parseSendResponse({ ...send(), Status: "Success" }, context), /invalid_ssm_response/);
  for (const key of ["CommandId", "InstanceIds", "DocumentName", "DocumentVersion", "Comment"]) {
    const body = send(); delete body.Command[key]; assert.throws(() => parseSendResponse(body, context));
  }
});
test("every frozen conservative pair is an exact minimal typed projection", () => {
  for (const [Status, StatusDetails, status, ResponseCode] of [["Pending", "Pending", "Pending", -1], ["InProgress", "In Progress", "InProgress", -1],
    ["Delayed", "Delayed", "Delayed", -1], ["Cancelling", "Cancelling", "Cancelling", -1], ["Success", "Success", "Success", 0],
    ["Failed", "Failed", "Failed", 2], ["Cancelled", "Cancelled", "Cancelled", -1], ["TimedOut", "Delivery Timed Out", "DeliveryTimedOut", -1],
    ["TimedOut", "Execution Timed Out", "ExecutionTimedOut", 124]]) {
    assert.deepEqual(parseInvocationResponse({ ...invocation(), Status, StatusDetails, ResponseCode }, commandContext), { commandId, status, responseCode: ResponseCode });
  }
});
test("invocation rejects wrong plugin/node/document/comment/command, unknown/missing pairs and false success", () => {
  for (const delta of [{ CommandId: randomUUID() }, { InstanceId: "i-11111111111111111" }, { PluginName: "aws:RunShellScript" },
    { DocumentName: "AWS-RunShellScript" }, { DocumentVersion: "2" }, { Comment: "wrong" }, { Status: "Undeliverable", StatusDetails: "Undeliverable" },
    { Status: "Terminated", StatusDetails: "Terminated" }, { StatusDetails: "AccessDenied" }, { StatusDetails: undefined }, { ResponseCode: -1 },
    { ResponseCode: 0.1 }, { ResponseCode: Number.MAX_SAFE_INTEGER + 1 }, { Status: "Failed", StatusDetails: "Failed", ResponseCode: 0 }]) {
    assert.throws(() => parseInvocationResponse({ ...invocation(), ...delta }, commandContext), /invalid_ssm_response/);
  }
});
test("full local context cannot be supplied from wire or replaced by a foreign profile", () => {
  for (const delta of [{ ownerId: undefined }, { fence: 0 }, { commandId }, { submitToken: null }, { requestHash: null },
    { executionIdentity: "fixture-other" }, { revision: 1 }, { target: { ...context.target, region: "production" } },
    { target: { ...context.target, volumeId: "fixture-other" } }]) assert.throws(() => parseSendResponse(send(), { ...context, ...delta }), /invalid_ssm_context/);
  assert.throws(() => parseInvocationResponse(invocation(), context), /invalid_ssm_context/);
  assert.throws(() => parseSendResponse({ ...send(), ownerId: context.ownerId }, context), /invalid_ssm_response/);
});
test("cancel accepts only normalized empty acknowledgement, never terminal status", () => {
  assert.deepEqual(parseCancelResponse(null), { acknowledgement: true }); assert.deepEqual(parseCancelResponse({}), { acknowledgement: true });
  for (const value of [[], "", { Status: "Success" }, undefined, Object.create(null)]) assert.throws(() => parseCancelResponse(value), /invalid_ssm_response/);
});
test("bounded ordinary JSON rejects getters without executing them, cycles, symbols, excessive depth/strings and holes", () => {
  let reads = 0; const accessor = {};
  Object.defineProperty(accessor, "Command", { enumerable: true, get() { reads++; return send().Command; } });
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 20; i++) deep = { nested: deep };
  const hole = send(); hole.Command.InstanceIds = new Array(1);
  for (const value of [accessor, cycle, deep, hole, { ...send(), [Symbol("secret")]: true }, { Command: { ...send().Command, Comment: "x".repeat(65537) } },
    Object.create(send()), { Command: { ...send().Command, Extra: "unused" } }]) assert.throws(() => parseSendResponse(value, context), /invalid_ssm_response/);
  assert.equal(reads, 0);
});
