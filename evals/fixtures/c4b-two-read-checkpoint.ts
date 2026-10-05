/** Safe reference strategy, reachable only via the explicit synthetic preload. */
export * from "../a1-quality-checkpoint.js";
import {
  loadA1QualityCheckpoint, verifiedFailedA1CheckpointSha256,
  type A1QualityCheckpointContext, type A1QualityCheckpointPlanCase,
} from "../a1-quality-checkpoint.js";

export function loadVerifiedA1QualityCheckpoint(
  manifestPath: string, checkpointPath: string, context: A1QualityCheckpointContext,
  plan: readonly A1QualityCheckpointPlanCase[],
) {
  const checkpoint_sha256 = verifiedFailedA1CheckpointSha256(manifestPath, checkpointPath);
  return { checkpoint: loadA1QualityCheckpoint(checkpointPath, context, plan, checkpoint_sha256), checkpoint_sha256 };
}
