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
