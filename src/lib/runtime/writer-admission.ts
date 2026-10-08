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
