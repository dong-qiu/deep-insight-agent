/** Shared structural port for isolated writer registration. Contains no runtime adapter or readiness grant. */
export interface WriterGenerationToken { workerId: string; generationToken: string }
export interface WriterTaskToken extends WriterGenerationToken { taskId: string }
export type WriterOutcome = "no_claim" | "done" | "failed" | "threw";
export interface WriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  admit(): WriterTaskToken;
  finish(token: WriterTaskToken, outcome: WriterOutcome): void;
}

import type { DB } from "../db/index.js";
import type { DispatchClaim, finishGenerationDispatch } from "../db/provenance.js";
export type DispatchOutcome = Parameters<typeof finishGenerationDispatch>[2];
export type TerminalDenyCode = "writer_terminal_closed" | "writer_terminal_capability_invalid" |
  "writer_terminal_business_mismatch" | "writer_terminal_reverse_transaction" | "writer_terminal_busy" |
  "writer_terminal_claim_mismatch" | "generation_fence_lost" | "writer_terminal_commit_failed";
export type TerminalUnknownCode = "writer_terminal_business_commit_unknown" | "writer_terminal_registry_commit_unknown";
export type TerminalCommitResult =
  | { kind: "committed"; businessCommit: "committed" }
  | { kind: "not_committed"; businessCommit: "not_committed"; code: TerminalDenyCode }
  | { kind: "unknown"; businessCommit: "committed" | "unknown"; code: TerminalUnknownCode };
declare const terminalCapability: unique symbol;
export interface FreshTerminalTaskCapability { readonly [terminalCapability]: true }
export interface FixedTerminalDispatchDriver {
  readonly db: DB;
  commit(claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult;
  close(): void;
}
export interface TerminalWriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  readonly version: "a3-terminal-commit-v1";
  readonly profile: "close-fences-terminal";
  admit(): FreshTerminalTaskCapability;
  bindClaim(cap: FreshTerminalTaskCapability, actualClaim: DispatchClaim): void;
  commitOutcome(cap: FreshTerminalTaskCapability, claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult;
  finish(cap: FreshTerminalTaskCapability, outcome: WriterOutcome): void;
}

/** Independently opted-in staged profile; legacy strict result semantics remain unchanged. */
export type StagedDenyCode = TerminalDenyCode | "staged_terminal_capability_invalid" |
  "staged_terminal_claim_mismatch" | "staged_terminal_business_mismatch" | "staged_terminal_owner_lost" |
  "staged_terminal_closed" | "staged_terminal_revoked" | "staged_terminal_busy";
export type StagedUnknownCode = TerminalUnknownCode | "staged_terminal_reservation_unknown" | "staged_terminal_gate_commit_unknown";
export type StagedTerminalCommitResult =
  | { kind: "committed"; businessCommit: "committed" }
  | { kind: "not_committed"; businessCommit: "not_committed"; code: StagedDenyCode }
  | { kind: "unknown"; businessCommit: "not_committed" | "committed" | "unknown"; code: StagedUnknownCode };
declare const stagedCapability: unique symbol;
export interface FreshStagedTaskCapability { readonly [stagedCapability]: true }
export interface StagedTerminalWriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  readonly version: "a3-staged-terminal-v1";
  readonly profile: "cooperative-close-then-revoke-terminal";
  admit(): FreshStagedTaskCapability;
  bindClaim(cap: FreshStagedTaskCapability, actualClaim: DispatchClaim): void;
  commitOutcome(cap: FreshStagedTaskCapability, actualClaim: DispatchClaim, outcome: DispatchOutcome): StagedTerminalCommitResult;
  finish(cap: FreshStagedTaskCapability, outcome: WriterOutcome): void;
}

/** Independent fixed accounting consumer; does not change terminal profile semantics. */
import type { UsageIdentity, UsageObservation } from "../db/model-usage.js";
export type UsageDenyCode = "writer_usage_closed" | "writer_usage_capability_invalid" |
  "writer_usage_business_mismatch" | "writer_usage_reverse_transaction" | "writer_usage_busy" |
  "writer_usage_claim_mismatch" | "writer_usage_cancelled" | "writer_usage_commit_failed" |
  "generation_fence_lost" | "usage_identity_invalid" | "usage_identity_conflict" |
  "usage_schema_unavailable" | "usage_observation_invalid" | "usage_count_invalid" |
  "usage_attempt_missing" | "usage_observation_stale" | "usage_observation_conflict";
export type UsageCommitResult =
  | { kind: "committed"; businessCommit: "committed"; replayed: boolean }
  | { kind: "not_committed"; businessCommit: "not_committed"; code: UsageDenyCode }
  | { kind: "unknown"; businessCommit: "committed" | "unknown";
      code: "writer_usage_business_commit_unknown" | "writer_usage_registry_commit_unknown"; replayed?: boolean };
declare const usageCapability: unique symbol;
export interface FreshUsageTaskCapability { readonly [usageCapability]: true }
export interface FixedUsageDispatchDriver {
  readonly db: DB;
  begin(claim: DispatchClaim, identity: UsageIdentity): UsageCommitResult;
  observe(claim: DispatchClaim, identity: UsageIdentity, observation: UsageObservation): UsageCommitResult;
  close(): void;
}
export interface BoundUsageRun {
  readonly db: DB;
  readonly runId: string;
  readonly traceId: string;
  beginAttempt(identity: UsageIdentity): UsageCommitResult;
  observeAttempt(attemptId: string, observation: UsageObservation): UsageCommitResult;
}
export interface UsageWriterAdmission {
  readonly scope: "isolated";
  readonly entryPoint: "generation-dispatch";
  readonly version: "a3-usage-commit-v1";
  readonly profile: "close-fences-usage-v1";
  admit(): FreshUsageTaskCapability;
  bindClaim(cap: FreshUsageTaskCapability, claim: DispatchClaim): void;
  bindRun(cap: FreshUsageTaskCapability, run: { runId: string; traceId: string }, signal: AbortSignal): BoundUsageRun;
  finish(cap: FreshUsageTaskCapability, outcome: WriterOutcome): void;
}
