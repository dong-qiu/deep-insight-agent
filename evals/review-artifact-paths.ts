import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve a review queue from the atomic completed-run pointer, never the obsolete shared path. */
export function latestReviewQueuePath(root = "evals/out/runs"): string {
  const pointerPath = join(root, "latest-complete.json");
  if (!existsSync(pointerPath)) throw new Error("找不到已完成的 A1 run；请先跑 npm run eval:a1，或显式传入 review-queue.json 路径");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { run_id?: unknown };
  const runId = typeof pointer.run_id === "string" ? pointer.run_id : "";
  if (!/^a1-\d{14}-[a-f0-9]{8}$/u.test(runId)) throw new Error("latest-complete.json 的 run_id 非法");
  const queuePath = join(root, runId, "review-queue.json");
  if (!existsSync(queuePath)) throw new Error(`已完成 run 缺少 review queue：${queuePath}`);
  return queuePath;
}
