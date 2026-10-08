export interface DrainTarget {
  region: 'isolated'; instanceId: string; volumeId: string; dataPath: string; serviceSet: string[];
}
export interface DrainRequest {
  operationId: string; ownerId: string; kind: 'deploy' | 'backup' | 'restore';
  executionIdentity: string; target: DrainTarget;
}
export interface DrainToken extends Omit<DrainRequest, 'kind'> { fence: number; revision: number }
export interface DrainBlocked {
  drain_ready: false; writer_quiescence: false; production_permitted: false; process_termination: 'unknown';
}
export interface DrainLeaseSample extends DrainBlocked {
  schema: 'a3-drain-observation-v1'; scope: 'isolated'; sampledAt: number;
  queued: number; claimedCurrent: number; claimedExpired: number; unknown: number;
  source: { root: string; databasePath: string; marker: object };
}
export interface DrainLeaseSource { sample(atUnixMs: number): DrainLeaseSample; close(): void }
export interface DrainObservation extends DrainBlocked {
  schema: 'a3-drain-observation-v1'; scope: 'isolated'; reason: string; token: DrainToken | null;
  sample: DrainLeaseSample | null; polls: number; controller_uniqueness: 'unknown';
}
export function openDrainLeaseSource(root: string, databasePath: string): DrainLeaseSource;
export function observeDrain(input: {
  root: string; request: DrainRequest; deadlineAt: number; pollEveryMs: number;
  signal?: AbortSignal; leaseSource: DrainLeaseSource;
}): Promise<DrainObservation>;
