/** 独立 dispatch worker 调用的单次执行器。worker 本身无业务写入权限，所有 claim/fencing 由 DB 原语守护。 */
import type { DB } from "../db/index.js";
import {
  claimNextGenerationDispatch,
  assertGenerationDispatchClaim,
  finishGenerationDispatch,
  getGenerationTraceStatus,
  heartbeatGenerationDispatch,
} from "../db/provenance.js";
import { runPipelineForTopic, runScheduledTopicPipeline, type GenerationExecutionOptions } from "./scheduler.js";
import { deploymentAnchorPublicationIfEnabled } from "../runtime/integrity-anchor-runtime.js";
import { NOOP_P1_TELEMETRY_SINK, type P1TelemetrySink } from "../capabilities/p1-telemetry.js";

const HEARTBEAT_MS = 30_000;
const STABLE_DISPATCH_FAILURE_CODES = new Set([
  "generation_event_idempotency_conflict",
  "provenance_revision_conflict",
  "integrity_anchor_not_configured",
  "integrity_anchor_enabled_invalid",
  "integrity_anchor_admission_required",
  "invalid_scheduled_dispatch_payload",
  "invalid_scheduled_dispatch_window_end",
]);

function dispatchFailure(error: unknown): { reason_code: string; message: string; retryable: boolean } {
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
export interface GenerationDispatchRuntime {
  heartbeat?: typeof heartbeatGenerationDispatch;
  heartbeatMs?: number;
  /** Supplied by the worker composition root; core dispatch is dormant by default. */
  telemetry?: P1TelemetrySink;
}

export async function runGenerationDispatchOnce(
  db: DB,
  execute: (db: DB, topicId: string, opts: GenerationExecutionOptions & { reportType: "brief" | "deep_dive" | "initial_digest"; windowHours?: number; windowEnd?: string; items?: number }) => Promise<unknown> = executeDispatch,
  runtime: GenerationDispatchRuntime = {},
): Promise<{ claimed: boolean; traceId?: string; status?: "done" | "failed" }> {
  const claim = claimNextGenerationDispatch(db);
  if (!claim) return { claimed: false };
  let lostLease = false;
  const heartbeat = runtime.heartbeat ?? heartbeatGenerationDispatch;
  const timer = setInterval(() => {
    try {
      if (!heartbeat(db, claim)) lostLease = true;
    } catch {
      // A heartbeat error is equivalent to losing ownership.  Never let an
      // interval callback throw outside the dispatch transaction boundary.
      lostLease = true;
    }
  }, runtime.heartbeatMs ?? HEARTBEAT_MS);
  try {
    await execute(db, claim.payload.topic_id, {
      traceId: claim.traceId,
      rootRunId: claim.rootRunId,
      reportType: claim.payload.report_type,
      windowHours: claim.payload.window_hours,
      windowEnd: claim.payload.window_end,
      items: claim.payload.items,
      assertWrite: () => {
        if (lostLease) throw new Error("generation_fence_lost");
        assertGenerationDispatchClaim(db, claim);
      },
      telemetry: runtime.telemetry ?? NOOP_P1_TELEMETRY_SINK,
    });
    if (lostLease || !finishGenerationDispatch(db, claim, { status: "done" })) {
      throw new Error("generation dispatch lease was lost before completion");
    }
    const traceStatus = getGenerationTraceStatus(db, claim.traceId)?.status;
    if (traceStatus !== "done" && traceStatus !== "partial") {
      throw new Error(`generation dispatch completed without a publishable trace (${String(traceStatus)})`);
    }
    return { claimed: true, traceId: claim.traceId, status: "done" };
  } catch (error) {
    if (!lostLease) {
      finishGenerationDispatch(db, claim, {
        status: "failed", error: dispatchFailure(error),
      });
    }
    return { claimed: true, traceId: claim.traceId, status: "failed" };
  } finally {
    clearInterval(timer);
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
    traceId: opts.traceId, rootRunId: opts.rootRunId, windowEnd: opts.windowEnd, assertWrite: opts.assertWrite, anchor, telemetry: opts.telemetry,
  });
}
