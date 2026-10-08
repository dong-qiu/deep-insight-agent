import type { MaintenanceStatus, MaintenanceToken } from "./ssm-response.mjs";
export interface IsolatedSsmTransportInput {
  readonly root: string; readonly action: "send" | "invocation" | "cancel"; readonly inputJson: string;
  readonly endpoint: string; readonly deadlineAt: number; readonly signal?: AbortSignal;
}
export interface IsolatedSsmTransportResult {
  readonly schema: "a3-isolated-ssm-transport-result-v1"; readonly scope: "loopback-aws-cli";
  readonly production_permitted: false; readonly maintenance_permitted: false; readonly ready: false;
  readonly termination: "unknown"; readonly safe_rollback: null; readonly token: null;
  /** Original controller blocked result is conservatively unknown: it may be a pre-CAS rejection or a lost COMMIT acknowledgement. */
  readonly stage: "not_attempted" | "committed" | "unknown"; readonly child: "not_started" | "started" | "unknown";
  readonly response: "unavailable" | "accepted_or_replay" | "invalid";
  readonly hold: "not_attempted" | "committed" | "unknown"; readonly commandId: string | null;
  readonly observedStatus: MaintenanceStatus | null; readonly reason: string | null; readonly first_control_reason: string | null;
}
export type { MaintenanceToken };
export function runIsolatedSsmTransport(input: IsolatedSsmTransportInput): Promise<IsolatedSsmTransportResult>;
export function runIsolatedSsmTransportCli(): Promise<void>;
