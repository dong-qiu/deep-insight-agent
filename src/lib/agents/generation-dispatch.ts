/** 独立 dispatch worker 调用的单次执行器。worker 本身无业务写入权限，所有 claim/fencing 由 DB 原语守护。 */
import type { DB } from "../db/index.js";
import {
  claimNextGenerationDispatch,
  assertGenerationDispatchClaim,
  finishGenerationDispatch,
  heartbeatGenerationDispatch,
} from "../db/provenance.js";
import { runPipelineForTopic } from "./scheduler.js";

const HEARTBEAT_MS = 30_000;

export async function runGenerationDispatchOnce(
  db: DB,
  execute: typeof runPipelineForTopic = runPipelineForTopic,
): Promise<{ claimed: boolean; traceId?: string; status?: "done" | "failed" }> {
  const claim = claimNextGenerationDispatch(db);
  if (!claim) return { claimed: false };
  let lostLease = false;
  const timer = setInterval(() => {
    if (!heartbeatGenerationDispatch(db, claim)) lostLease = true;
  }, HEARTBEAT_MS);
  try {
    await execute(db, claim.payload.topic_id, {
      traceId: claim.traceId,
      rootRunId: claim.rootRunId,
      assertWrite: () => {
        if (lostLease) throw new Error("generation_fence_lost");
        assertGenerationDispatchClaim(db, claim);
      },
    });
    if (lostLease || !finishGenerationDispatch(db, claim, { status: "done" })) {
      throw new Error("generation dispatch lease was lost before completion");
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
