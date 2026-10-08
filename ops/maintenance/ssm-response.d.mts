export interface MaintenanceTarget {
  readonly region: "isolated"; readonly instanceId: string; readonly volumeId: string;
  readonly dataPath: string; readonly serviceSet: readonly string[];
}
export interface MaintenanceToken {
  readonly operationId: string; readonly ownerId: string; readonly fence: number; readonly revision: number;
  readonly target: MaintenanceTarget; readonly executionIdentity: string;
}
export interface MaintenanceBinding extends Omit<MaintenanceToken, "revision"> {
  readonly commandId: string | null; readonly submitToken: string | null; readonly requestHash: string | null;
}
export interface FixedSubmitContext extends MaintenanceBinding {
  readonly commandId: null; readonly submitToken: string; readonly requestHash: string;
}
export interface FixedCommandContext extends MaintenanceBinding {
  readonly commandId: string; readonly submitToken: string; readonly requestHash: string;
}
export type MaintenanceStatus = "Pending" | "InProgress" | "Delayed" | "Cancelling" | "Success" | "Failed" | "Cancelled" | "TimedOut" | "Undeliverable" | "Terminated" | "DeliveryTimedOut" | "ExecutionTimedOut";
/** Immutable synthetic descriptor; no resource or transport exists. */
export declare const FIXTURE_WIRE: Readonly<{
  InstanceId: "i-00000000000000000"; DocumentName: "InsightA3FixtureRecordOnly";
  DocumentVersion: "1"; PluginName: "fixtureRecordOnly";
}>;
export function parseSendResponse(body: unknown, expected: FixedSubmitContext): { commandId: string };
export function parseInvocationResponse(body: unknown, expected: FixedCommandContext): { commandId: string; status: MaintenanceStatus; responseCode: number };
export function parseCancelResponse(body: unknown): { acknowledgement: true };
