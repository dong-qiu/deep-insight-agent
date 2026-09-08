/**
 * A1 run artifacts are isolated by run id. A completed directory is only made visible after all
 * files and its manifest have been written into a sibling temporary directory; `latest-complete`
 * is a convenience pointer to an execution, never a statement that its quality gate passed.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface A1RunWorkspace {
  runId: string;
  root: string;
  tempDir: string;
  finalDir: string;
  startedAt: string;
}

export interface A1RunManifest {
  run_id: string;
  status: "completed" | "failed";
  /** `completed` only means files were finalized. Consumers must inspect this separately. */
  gate_outcome: "pass" | "fail" | "smoke" | "not_evaluated";
  started_at: string;
  ended_at: string;
  config: Record<string, unknown>;
  dataset: Record<string, unknown>;
  source: { commit: string | null; dirty_fingerprint: string | null };
  artifacts: Record<string, string>;
  error?: string;
}

export function beginA1Run(root = "evals/out/runs", startedAt = new Date().toISOString()): A1RunWorkspace {
  const stamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const runId = `a1-${stamp}-${randomUUID().slice(0, 8)}`;
  const tempDir = join(root, `.${runId}.tmp`);
  const finalDir = join(root, runId);
  mkdirSync(root, { recursive: true });
  mkdirSync(tempDir, { recursive: false });
  return { runId, root, tempDir, finalDir, startedAt };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Atomic on a single filesystem: consumers see either no run directory or the complete one. */
export function finalizeA1Run(workspace: A1RunWorkspace, manifest: A1RunManifest): void {
  writeJson(join(workspace.tempDir, "manifest.json"), manifest);
  renameSync(workspace.tempDir, workspace.finalDir);
  if (manifest.status === "completed") {
    const pointer = join(workspace.root, "latest-complete.json");
    const pointerTmp = `${pointer}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
    writeJson(pointerTmp, {
      run_id: manifest.run_id,
      manifest: join(workspace.finalDir, "manifest.json"),
      completed_at: manifest.ended_at,
      // Deliberately duplicated so scripts do not accidentally treat `latest` as a pass badge.
      gate_outcome: manifest.gate_outcome,
    });
    renameSync(pointerTmp, pointer);
  }
}

/** Best-effort only: a secondary failure while recording a failed run must not hide its root cause. */
export function finalizeFailedA1Run(workspace: A1RunWorkspace, manifest: A1RunManifest): void {
  if (!existsSync(workspace.tempDir)) return;
  finalizeA1Run(workspace, manifest);
}
