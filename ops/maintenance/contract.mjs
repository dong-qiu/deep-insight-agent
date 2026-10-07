import { createHash } from "node:crypto";
import { z } from "zod";

export const check = (condition, code) => { if (!condition) throw new Error(code); };
export const parse = (schema, value) => {
  const result = schema.safeParse(value);
  check(result.success, "invalid_maintenance_record");
  return result.data;
};
export const canonical = value => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isFinite(value), "invalid_json"); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) check(Object.hasOwn(value, i), "invalid_json");
    return `[${value.map(canonical).join(",")}]`;
  }
  check(value && Object.getPrototypeOf(value) === Object.prototype, "invalid_json");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const same = (a, b) => canonical(a) === canonical(b);
export const DOMAIN = "insight-a3-authorization-v1\n";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const opId = z.string().regex(/^op-[A-Za-z0-9_-]{1,124}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/^0+$/.test(value));
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const targetSchema = z.strictObject({
  region: z.literal("isolated"), instanceId: z.string().regex(/^fixture-[A-Za-z0-9_-]+$/),
  volumeId: z.string().regex(/^fixture-[A-Za-z0-9_-]+$/), dataPath: z.string().min(1),
  serviceSet: z.array(id).min(1).max(16).refine(value => same(value, [...new Set(value)].sort())),
});
export const configSchema = z.strictObject({ target: targetSchema, approverId: id, publicKey: z.string().max(4096) });
export const markerSchema = configSchema.extend({ schema: z.literal("a3-isolation-v1"), initId: z.uuid() });
export const requestSchema = z.strictObject({
  operationId: opId, ownerId: id, kind: z.enum(["deploy", "backup", "restore"]),
  executionIdentity: z.string().regex(/^fixture-[A-Za-z0-9_-]+$/), target: targetSchema,
});
export const tokenSchema = z.strictObject({
  operationId: opId, ownerId: id, fence: integer.min(1), revision: integer,
  target: targetSchema, executionIdentity: requestSchema.shape.executionIdentity,
});
export const bindingSchema = tokenSchema.omit({ revision: true }).extend({
  commandId: z.uuid().nullable(), submitToken: z.uuid().nullable(), requestHash: digest.nullable(),
});
export const terminalSchema = z.enum(["Success", "Failed", "Cancelled", "TimedOut", "Undeliverable", "Terminated", "DeliveryTimedOut", "ExecutionTimedOut"]);
export const responseSchema = bindingSchema.extend({ status: z.enum(["Pending", "InProgress", "Delayed", "Cancelling", ...terminalSchema.options]) });
export const authorizationSchema = bindingSchema.extend({
  schema: z.literal("a3-authorization-v1"), revision: integer, approverId: id,
  action: z.enum(["takeover", "release", "terminal_verify"]), reason: z.string().trim().min(8).max(500),
  processesStopped: z.boolean(), evidenceHash: digest.nullable(),
});
export const signedSchema = z.strictObject({ payload: authorizationSchema, signature: z.string().regex(/^[a-f0-9]{128}$/) });
export const evidenceSchema = bindingSchema.extend({
  schema: z.literal("fixture-process-stop-v1"), remoteFixtureStopped: z.literal(true),
  localControllerStopped: z.literal(true), continuationsStopped: z.literal(true),
  outcome: z.enum([...terminalSchema.options, "NotSubmitted"]),
});
const operationSchema = requestSchema.extend({
  fence: integer.min(1), revision: integer, state: z.enum(["pre_submit", "submission_unknown", "submitted", "running", "cancel_requested", "terminal_pending", "terminal_verified", "manual_takeover"]),
  disposition: z.enum(["active", "held", "released"]), commandId: z.uuid().nullable(),
  submitToken: z.uuid().nullable(), requestHash: digest.nullable(), terminal: terminalSchema.nullable(),
  authorizations: z.array(z.strictObject({ signed: signedSchema, evidenceBytes: z.string().max(16384).nullable() })),
  failures: z.array(id), observations: z.array(responseSchema.shape.status),
});
export const stateSchema = z.strictObject({
  schema: z.literal("a3-ledger-v1"), marker: markerSchema, revision: integer, fence: integer,
  active: opId.nullable(), operations: z.record(opId, operationSchema),
});
export const tokenFor = operation => parse(tokenSchema, {
  operationId: operation.operationId, ownerId: operation.ownerId, fence: operation.fence,
  revision: operation.revision, target: operation.target, executionIdentity: operation.executionIdentity,
});
export const bindingFor = operation => parse(bindingSchema, {
  operationId: operation.operationId, ownerId: operation.ownerId, fence: operation.fence,
  target: operation.target, executionIdentity: operation.executionIdentity,
  commandId: operation.commandId, submitToken: operation.submitToken, requestHash: operation.requestHash,
});
