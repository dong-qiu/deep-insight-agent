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

const HEARTBEAT_MS = 30_000;

/** Injection seam for deterministic failure tests.  Production always uses
 * the DB CAS heartbeat and the standard 30s cadence. */
export interface GenerationDispatchRuntime {
  heartbeat?: typeof heartbeatGenerationDispatch;
  heartbeatMs?: number;
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
    const message = error instanceof Error ? error.message : String(error);
    if (!lostLease) {
      finishGenerationDispatch(db, claim, {
        status: "failed", error: { reason_code: "dispatch_failed", message: message.slice(0, 512) },
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
  const anchor = deploymentAnchorPublicationIfEnabled();
  if (opts.reportType === "deep_dive" && opts.windowHours == null) {
    return runPipelineForTopic(db, topicId, { ...opts, anchor });
  }
  if (opts.windowHours == null || opts.items == null) throw new Error("invalid_scheduled_dispatch_payload");
  return runScheduledTopicPipeline(db, topicId, {
    reportType: opts.reportType, windowHours: opts.windowHours, items: opts.items,
    traceId: opts.traceId, rootRunId: opts.rootRunId, windowEnd: opts.windowEnd, assertWrite: opts.assertWrite, anchor,
  });
}
