import type { DrainToken } from './drain.mjs';
export interface StagedStageToken {
  stageId: string; stageInitId: string; workerId: string; generationToken: string; epoch: 1; revision: number;
}
export type StableStagedRevokeReason = 'writer_drain_timeout' | 'writer_drain_cancelled' | 'cancelled' |
  'task_deadline_exceeded' | 'generation_fence_lost' | 'writer_drain_coverage_unknown' |
  'writer_drain_observation_failed' | 'staged_terminal_manual_block';
export interface StagedSnapshot {
  schema: 'a3-staged-terminal-v1'; scope: 'isolated'; profile: 'cooperative-close-then-revoke-terminal';
  token: StagedStageToken | null;
  stage: { id: 1; revision: number; epoch: 0 | 1; worker_id: string | null; generation_token: string | null;
    admission: 'open' | 'closed'; terminal: 'live' | 'revoked'; revoke_reason: StableStagedRevokeReason | null;
    drain_record: string | null; revoke_record: string | null };
  tasks: { task_id: string; worker_id: string; generation_token: string; epoch: 1 }[];
  claims: { task_id: string; dispatch_id: string; trace_id: string; owner_token: string; claim_epoch: number; fencing_epoch: number; root_run_id: string }[];
  attempts: { task_id: string; attempt_id: string }[];
  attempt_outcomes: { task_id: string; result: string }[];
  completions: { task_id: string; outcome: 'no_claim' | 'done' | 'failed' | 'threw' }[];
  writer_quiescence: false; drain_ready: false; production_permitted: false; process_termination: 'unknown';
}
export interface StagedTerminalControl {
  inspect(): StagedSnapshot;
  closeAdmission(expected: StagedStageToken): StagedStageToken;
  bindDrain(expected: StagedStageToken, heldMaintenance: DrainToken): StagedStageToken;
  revoke(expected: StagedStageToken, heldMaintenance: DrainToken, reason: StableStagedRevokeReason): StagedStageToken;
}
export function initializeStagedTerminal(root: string): void;
