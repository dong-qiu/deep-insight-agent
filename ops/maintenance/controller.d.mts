import type { MaintenanceStatus, MaintenanceToken } from "./ssm-response.mjs";
export type { MaintenanceStatus, MaintenanceToken } from "./ssm-response.mjs";
export type ControllerAction = "stage-submit" | "receive-send" | "receive-invocation" | "stage-cancel" | "receive-cancel" | "interrupt" | "resume";
export interface ControllerInput {
  schema: "a3-ssm-controller-v1"; token: MaintenanceToken;
  event?: { outcome: "response"; body: unknown } | { outcome: "unavailable" };
}
export interface ControllerResult {
  schema: "a3-ssm-controller-v1"; production_permitted: false; ready: false; termination: "unknown";
  outcome: "recorded" | "accepted_or_replay" | "blocked"; token: MaintenanceToken | null;
  hold: "recorded" | "unconfirmed" | "not_attempted"; commandId: string | null;
  observedStatus: MaintenanceStatus | null; reason: string | null;
}
export function runControllerStep(root: string, action: ControllerAction, input: ControllerInput): ControllerResult;
