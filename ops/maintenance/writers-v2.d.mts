import type Database from 'better-sqlite3';
export type WriterEntryV2 = 'generation-dispatch' | 'source-collect' | 'startup' | 'local-seed' | 'raw-recovery' | 'report-recovery';
export type WriterOutcomeV2 = 'completed' | 'completed_with_diagnostics' | 'denied' | 'cancelled' | 'interrupted_unknown';
declare const workerBrand: unique symbol;
declare const operationBrand: unique symbol;
declare const targetBrand: unique symbol;
export interface WorkerCapabilityV2 { readonly [workerBrand]: true }
export interface OperationCapabilityV2 { readonly [operationBrand]: true }
export interface BusinessTargetV2 { readonly [targetBrand]: true; readonly db: Database.Database; close(): void }
export type ScopeV2 =
  | { kind: 'startup'; configHash: string; runtimeVersion: string; mode: 'initialize-existing' }
  | { kind: 'local-seed'; configHash: string; runtimeVersion: string; mode: 'local-create' }
  | { kind: 'dispatch'; purpose: 'usage' | 'terminal'; claim: { dispatchId: string; traceId: string; ownerToken: string; claimEpoch: number; fencingEpoch: number; rootRunId: string } }
  | { kind: 'source-prelude'; sourceId: string; triggerKind: 'cron' | 'api' | 'retry' | 'probe'; scopeKey: string; retryOfTraceId: string | null; retryOfRunId: string | null; requestTimeIso: string }
  | { kind: 'raw-recovery' | 'report-recovery'; effectId: string; idempotencyKey: string; manifestHash: string; payloadHash: string };
export interface FilesystemFactV2 { action: 'create' | 'open' | 'configure'; path: string; outcome: 'occurred' | 'not_occurred' | 'unknown' }
export type BusinessCommitV2 = 'not_committed' | 'committed' | 'unknown' | 'not_applicable';
export type PreopenResultV2 =
  | { kind: 'committed'; businessCommit: 'committed'; coordination: 'acknowledged'; target: BusinessTargetV2; filesystem: FilesystemFactV2[] }
  | { kind: 'not_committed'; businessCommit: 'not_committed' | 'not_applicable'; coordination: 'acknowledged'; code: string | null; filesystem?: FilesystemFactV2[] }
  | { kind: 'unknown'; businessCommit: BusinessCommitV2; coordination: 'acknowledged' | 'unknown'; code: string | null; filesystem?: FilesystemFactV2[] };
export interface WriterSnapshotV2 {
  schema: 'a3-writer-admission-v2'; scope: 'isolated'; admission: 'open' | 'closed';
  workers: { worker_id: string; generation_token: string; entry_point: WriterEntryV2 }[];
  operations: { operation_id: string; task_id: string; invocation_id: string; scope_json: string; input_hash: string; recovery_of: string | null; terminal: { operation_id: string; outcome: WriterOutcomeV2; first_reason: string } | null }[];
  steps: { step_id: string; operation_id: string; step_key: 'open-business'; ordinal: number; input_hash: string; result: { step_id: string; business_commit: BusinessCommitV2; filesystem_json: string; disposition: 'completed' | 'denied' | 'cancelled' | 'unsupported' | 'unknown'; reason: string } | null; observed: 'recorded' | 'unknown' }[];
  bindings: { step_id: string; target_kind: 'business'; identity_json: string }[];
  writer_quiescence: false; drain_ready: false; production_permitted: false;
}
export type CloseResultV2 =
  | { close_commit: 'committed' | 'not_committed'; disposition: 'closed' | 'observed_closed'; inventory: WriterSnapshotV2 }
  | { close_commit: 'unknown'; code: string; writer_quiescence: false; drain_ready: false; production_permitted: false };
export interface WritersV2 {
  register(workerId: string, entryPoint: WriterEntryV2): WorkerCapabilityV2;
  admit(worker: WorkerCapabilityV2, scope: ScopeV2, signal: AbortSignal): OperationCapabilityV2;
  finish(operation: OperationCapabilityV2, outcome: WriterOutcomeV2): { operation_id: string; outcome: WriterOutcomeV2; first_reason: string };
  inspect(): WriterSnapshotV2;
  closeAdmission(): CloseResultV2;
  close(): void;
}
export function initializeWritersV2(root: string): Readonly<{ schema: 'a3-writers-isolation-v2'; initId: string }>;
export function openWritersV2(root: string): WritersV2;
/** Fixed pre-open only; not a generic reservation/driver/SQL callback API. */
export function openV2BusinessTarget(operation: OperationCapabilityV2): PreopenResultV2;
