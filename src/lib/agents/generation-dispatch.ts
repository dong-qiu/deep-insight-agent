/** 独立 dispatch worker 调用的单次执行器。worker 本身无业务写入权限，所有 claim/fencing 由 DB 原语守护。 */
import { createTaskCancellation, TaskCancellationError, type TaskCancellationOptions } from "../runtime/cancellation.js";
import { checkTaskBudget, loadTaskBudgetUsd, TaskBudgetError, validateTaskBudget, withTaskBudget, type TaskBudgetOptions } from "../runtime/task-budget.js";
import type { DB } from "../db/index.js";
import {
  type DispatchClaim,
  claimNextGenerationDispatch,
  assertGenerationDispatchClaim,
  finishGenerationDispatch,
  getGenerationTraceStatus,
  heartbeatGenerationDispatch,
} from "../db/provenance.js";
import { runPipelineForTopic, runScheduledTopicPipeline, type GenerationExecutionOptions } from "./scheduler.js";
import { deploymentAnchorPublicationIfEnabled } from "../runtime/integrity-anchor-runtime.js";
import { NOOP_P1_TELEMETRY_SINK, type P1TelemetrySink } from "../capabilities/p1-telemetry.js";

import type { WriterAdmission, WriterOutcome, TerminalWriterAdmission, StagedTerminalWriterAdmission, StagedTerminalCommitResult, TerminalCommitResult, DispatchOutcome } from "../runtime/writer-admission.js";

const HEARTBEAT_MS = 30_000;
const STABLE_DISPATCH_FAILURE_CODES = new Set([
  "usage_persistence_failed",
  "generation_event_idempotency_conflict",
  "provenance_revision_conflict",
  "integrity_anchor_not_configured",
  "integrity_anchor_enabled_invalid",
  "integrity_anchor_admission_required",
  "invalid_scheduled_dispatch_payload",
  "invalid_scheduled_dispatch_window_end",
]);

function dispatchFailure(error: unknown): { reason_code: string; message: string; retryable: boolean } {
  if (error instanceof TaskCancellationError) return { reason_code: error.reasonCode, message: error.reasonCode, retryable: false };
  if (error instanceof TaskBudgetError) return { reason_code: error.reasonCode, message: error.reasonCode, retryable: false };
  const message = error instanceof Error ? error.message : String(error);
  if (STABLE_DISPATCH_FAILURE_CODES.has(message)) {
    return { reason_code: message, message, retryable: false };
  }
  // A dispatch error may originate in an upstream response. Persist only the
  // stable code here; detailed, redacted diagnostics belong in service logs.
  return { reason_code: "dispatch_failed", message: "dispatch_failed", retryable: true };
}

/** Injection seam for deterministic failure tests.  Production always uses
 * the DB CAS heartbeat and the standard 30s cadence. */
export interface GenerationDispatchRuntime extends TaskCancellationOptions, TaskBudgetOptions {
  heartbeat?: typeof heartbeatGenerationDispatch;
  heartbeatMs?: number;
  /** Supplied by the worker composition root; core dispatch is dormant by default. */
  telemetry?: P1TelemetrySink;
  /** Isolated core registration only; not HTTP/startup coverage or a drain-ready proof. */
  writerAdmission?: WriterAdmission;
  /** Explicit isolated strict terminal profile; never supplied by production composition. */
  terminalWriterAdmission?: TerminalWriterAdmission;
  /** Explicit new cooperative-close/revoke profile; isolated fixed composition only. */
  stagedTerminalWriterAdmission?: StagedTerminalWriterAdmission;
}

interface DispatchExecutionResult { claimed: boolean; traceId?: string; status?: "done" | "failed";
  terminalCommit?: TerminalCommitResult; stagedTerminalCommit?: StagedTerminalCommitResult }
type CoreTerminalPort =
  | { kind: "strict"; bindClaim(claim: DispatchClaim): void; commitOutcome(claim: DispatchClaim, outcome: DispatchOutcome): TerminalCommitResult }
  | { kind: "staged"; bindClaim(claim: DispatchClaim): void; commitOutcome(claim: DispatchClaim, outcome: DispatchOutcome): StagedTerminalCommitResult };

export async function runGenerationDispatchOnce(
  db: DB,
  execute: (db: DB, topicId: string, opts: GenerationExecutionOptions & { reportType: "brief" | "deep_dive" | "initial_digest"; windowHours?: number; windowEnd?: string; items?: number }) => Promise<unknown> = executeDispatch,
  runtime: GenerationDispatchRuntime = {},
): Promise<DispatchExecutionResult> {
  const staged = runtime.stagedTerminalWriterAdmission;
  if (staged) {
    const binding = (staged as unknown as Record<symbol, { businessDb: DB }>)[Symbol.for("insight-agent.a3-staged-terminal-admission-v1")];
    if (runtime.writerAdmission || runtime.terminalWriterAdmission || staged.scope !== "isolated" || staged.entryPoint !== "generation-dispatch"
      || staged.version !== "a3-staged-terminal-v1" || staged.profile !== "cooperative-close-then-revoke-terminal" || binding?.businessDb !== db) {
      throw new Error("staged_terminal_business_mismatch");
    }
    const cap = staged.admit();
    let result: DispatchExecutionResult;
    try { result = await runGenerationDispatchAdmittedOnce(db, execute, runtime, { kind: "staged",
      bindClaim: claim => staged.bindClaim(cap, claim), commitOutcome: (claim, outcome) => staged.commitOutcome(cap, claim, outcome) }); }
    catch (error) { staged.finish(cap, "threw"); throw error; }
    const outcome: WriterOutcome = result.claimed ? result.status === "done" ? "done" : "failed" : "no_claim";
    try { staged.finish(cap, outcome); }
    catch (error) { if (!result.stagedTerminalCommit) throw error; return { ...result, status: "failed" }; }
    return result;
  }
  const terminal = runtime.terminalWriterAdmission;
  if (terminal) {
    const binding = (terminal as unknown as Record<symbol, { businessDb: DB }>)[Symbol.for("insight-agent.a3-terminal-admission-v1")];
    if (runtime.writerAdmission || terminal.scope !== "isolated" || terminal.entryPoint !== "generation-dispatch"
      || terminal.version !== "a3-terminal-commit-v1" || terminal.profile !== "close-fences-terminal" || binding?.businessDb !== db) {
      throw new Error("writer_terminal_business_mismatch");
    }
    const cap = terminal.admit();
    let result: Awaited<ReturnType<typeof runGenerationDispatchAdmittedOnce>>;
    try { result = await runGenerationDispatchAdmittedOnce(db, execute, runtime, { kind: "strict", bindClaim: claim => terminal.bindClaim(cap, claim), commitOutcome: (claim, outcome) => terminal.commitOutcome(cap, claim, outcome) }); }
    catch (error) { terminal.finish(cap, "threw"); throw error; }
    const outcome: WriterOutcome = result.claimed ? result.status === "done" ? "done" : "failed" : "no_claim";
    try { terminal.finish(cap, outcome); }
    catch (error) {
      if (!result.terminalCommit) throw error;
      // Local completion remains unknown; never mask already observed COMMIT facts or retry a terminal write.
      return { ...result, status: "failed" };
    }
    return result;
  }
  const admission = runtime.writerAdmission;
  if (!admission) return runGenerationDispatchAdmittedOnce(db, execute, runtime);
  const token = admission.admit(); // Durable registration precedes claim/root Run writes.
  let outcome: WriterOutcome = "threw";
  try {
    const result = await runGenerationDispatchAdmittedOnce(db, execute, runtime);
    outcome = result.claimed ? result.status === "done" ? "done" : "failed" : "no_claim";
    return result;
  } finally {
    // Only this local executor's exit is known. Provider/descendant work remains unknown.
    admission.finish(token, outcome);
  }
}

async function runGenerationDispatchAdmittedOnce(
  db: DB,
  execute: (db: DB, topicId: string, opts: GenerationExecutionOptions & { reportType: "brief" | "deep_dive" | "initial_digest"; windowHours?: number; windowEnd?: string; items?: number }) => Promise<unknown> = executeDispatch,
  runtime: GenerationDispatchRuntime = {},
  terminal?: CoreTerminalPort,
): Promise<DispatchExecutionResult> {
  const taskBudgetUsd = runtime.taskBudgetUsd ?? loadTaskBudgetUsd();
  validateTaskBudget(taskBudgetUsd);
  const cancellation = createTaskCancellation(runtime);
  if (cancellation.signal.aborted) { cancellation.dispose(); return { claimed: false }; }
  let claim;
  try { claim = claimNextGenerationDispatch(db); } catch (error) { cancellation.dispose(); throw error; }
  if (!claim) { cancellation.dispose(); return { claimed: false }; }
  if (terminal) {
    try { terminal.bindClaim(claim); }
    catch { cancellation.dispose(); return { claimed: true, traceId: claim.traceId, status: "failed" }; }
  }
  const leaseCancellation = new AbortController();
  const task = createTaskCancellation({ signal: leaseCancellation.signal });
  const onCancel = (): void => leaseCancellation.abort(cancellation.signal.reason);
  cancellation.signal.addEventListener("abort", onCancel, { once: true });
  let lostLease = false;
  let terminalAttempted = false;
  let terminalResult: TerminalCommitResult | StagedTerminalCommitResult | undefined;
  const commitTerminal = (outcome: DispatchOutcome): TerminalCommitResult | StagedTerminalCommitResult => {
    terminalAttempted = true;
    try { terminalResult = terminal!.commitOutcome(claim, outcome); }
    catch { terminalResult = { kind: "unknown", businessCommit: "unknown", code: terminal!.kind === "staged" ? "staged_terminal_gate_commit_unknown" : "writer_terminal_registry_commit_unknown" }; }
    return terminalResult;
  };
  const terminalDiagnostic = (): Pick<DispatchExecutionResult, "terminalCommit" | "stagedTerminalCommit"> => terminal?.kind === "staged"
    ? { stagedTerminalCommit: terminalResult as StagedTerminalCommitResult } : { terminalCommit: terminalResult as TerminalCommitResult };
  const failedTerminalResult = (): DispatchExecutionResult => ({ claimed: true, traceId: claim.traceId, status: "failed", ...terminalDiagnostic() });
  const loseLease = (): void => { lostLease = true; leaseCancellation.abort(new TaskCancellationError("generation_fence_lost")); };
  const assertWrite = (): void => {
    if (lostLease) throw new Error("generation_fence_lost");
    try { assertGenerationDispatchClaim(db, claim); } catch (error) { loseLease(); throw error; }
  };
  const heartbeat = runtime.heartbeat ?? heartbeatGenerationDispatch;
  const timer = setInterval(() => {
    try {
      if (!heartbeat(db, claim)) loseLease();
    } catch {
      // A heartbeat error is equivalent to losing ownership.  Never let an
      // interval callback throw outside the dispatch transaction boundary.
      loseLease();
    }
  }, runtime.heartbeatMs ?? HEARTBEAT_MS);
  try {
    assertWrite();
    cancellation.check();
    task.check();
    await withTaskBudget(db, { taskBudgetUsd, traceId: claim.traceId }, async () => {
      await execute(db, claim.payload.topic_id, {
        signal: task.signal,
        deadlineAt: runtime.deadlineAt,
        traceId: claim.traceId,
        rootRunId: claim.rootRunId,
        reportType: claim.payload.report_type,
        windowHours: claim.payload.window_hours,
        windowEnd: claim.payload.window_end,
        items: claim.payload.items,
        assertWrite,
        taskBudgetUsd,
        telemetry: runtime.telemetry ?? NOOP_P1_TELEMETRY_SINK,
      });
      assertWrite(); cancellation.check(); task.check(); checkTaskBudget();
    });
    assertWrite();
    cancellation.check();
    task.check();
    if (terminal) {
      if (commitTerminal({ status: "done" }).kind !== "committed") return failedTerminalResult();
    } else if (lostLease || !finishGenerationDispatch(db, claim, { status: "done" })) {
      throw new Error("generation dispatch lease was lost before completion");
    }
    const traceStatus = getGenerationTraceStatus(db, claim.traceId)?.status;
    if (traceStatus !== "done" && traceStatus !== "partial") {
      throw new Error(`generation dispatch completed without a publishable trace (${String(traceStatus)})`);
    }
    return terminal ? { claimed: true, traceId: claim.traceId, status: "done", ...terminalDiagnostic() }
      : { claimed: true, traceId: claim.traceId, status: "done" };
  } catch (error) {
    // A denied/unknown/committed terminal attempt, including post-COMMIT read failure, is never retried as failed.
    if (terminalAttempted) return failedTerminalResult();
    if (!lostLease) {
      try { assertWrite(); } catch { return { claimed: true, traceId: claim.traceId, status: "failed" }; }
      const failure: DispatchOutcome = { status: "failed", error: dispatchFailure(task.signal.aborted ? task.signal.reason : error) };
      if (terminal) { commitTerminal(failure); return failedTerminalResult(); }
      finishGenerationDispatch(db, claim, failure);
    }
    return { claimed: true, traceId: claim.traceId, status: "failed" };
  } finally {
    clearInterval(timer);
    task.dispose();
    cancellation.signal.removeEventListener("abort", onCancel);
    cancellation.dispose();
  }
}

async function executeDispatch(
  db: DB,
  topicId: string,
  opts: GenerationExecutionOptions & { reportType: "brief" | "deep_dive" | "initial_digest"; windowHours?: number; windowEnd?: string; items?: number },
): Promise<unknown> {
  // The dispatch worker is the production publication composition root. P1c
  // is explicitly opt-in; once enabled, missing signer/store policy remains
  // fail-closed and cannot degrade to an unanchored fallback.
  const anchor = await deploymentAnchorPublicationIfEnabled();
  if (opts.reportType === "deep_dive" && opts.windowHours == null) {
    return runPipelineForTopic(db, topicId, { ...opts, anchor });
  }
  if (opts.windowHours == null || opts.items == null) throw new Error("invalid_scheduled_dispatch_payload");
  return runScheduledTopicPipeline(db, topicId, {
    reportType: opts.reportType, windowHours: opts.windowHours, items: opts.items,
    traceId: opts.traceId, rootRunId: opts.rootRunId, windowEnd: opts.windowEnd, signal: opts.signal, deadlineAt: opts.deadlineAt, taskBudgetUsd: opts.taskBudgetUsd, assertWrite: opts.assertWrite, anchor, telemetry: opts.telemetry,
  });
}
