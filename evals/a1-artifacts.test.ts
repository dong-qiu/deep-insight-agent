import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginA1Run, finalizeA1Run, sha256File } from "./a1-artifacts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "insight-a1-artifacts-"));
  roots.push(value);
  return value;
}

function manifest(runId: string, status: "completed" | "failed", autoGate: "pass" | "fail" | "smoke" | "not_evaluated") {
  return {
    run_id: runId, status, auto_gate: autoGate,
    manual_review: "pending", dcp_eligibility: autoGate === "pass" ? "pending_manual_review" : "ineligible",
    started_at: "2026-09-09T00:00:00.000Z", ended_at: "2026-09-09T00:01:00.000Z",
    config: {}, dataset: {}, source: { commit: "abc", dirty_fingerprint: "def" }, insights: { count: 0, ids_sha256: "empty" }, artifacts: {},
  } as const;
}

describe("A1 isolated artifacts", () => {
  it("records the early running manifest inside the private workspace", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(workspace.tempDir, "manifest.json"), "utf8"))).toMatchObject({
      run_id: workspace.runId, status: "running", auto_gate: "not_evaluated", dcp_eligibility: "not_evaluated",
    });
    expect(existsSync(workspace.finalDir)).toBe(false);
  });

  it("publishes a complete run then points latest-complete at it without implying pass", () => {
    const runs = root();
    const workspace = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    const artifact = join(workspace.tempDir, "review-queue.json");
    writeFileSync(artifact, "{}\n");
    finalizeA1Run(workspace, { ...manifest(workspace.runId, "completed", "fail"), artifacts: { "review-queue.json": sha256File(artifact) } });

    expect(existsSync(join(workspace.finalDir, "manifest.json"))).toBe(true);
    expect(existsSync(workspace.tempDir)).toBe(false);
    expect(JSON.parse(readFileSync(join(runs, "latest-complete.json"), "utf8"))).toMatchObject({
      run_id: workspace.runId, auto_gate: "fail", dcp_eligibility: "ineligible",
    });
  });

  it("records a failed run but never advances latest-complete", () => {
    const runs = root();
    const successful = beginA1Run(runs, "2026-09-09T00:00:00.000Z");
    finalizeA1Run(successful, manifest(successful.runId, "completed", "pass"));
    const failed = beginA1Run(runs, "2026-09-09T00:02:00.000Z");
    finalizeA1Run(failed, { ...manifest(failed.runId, "failed", "not_evaluated"), error: "network" });

    expect(JSON.parse(readFileSync(join(runs, "latest-complete.json"), "utf8")).run_id).toBe(successful.runId);
    expect(JSON.parse(readFileSync(join(failed.finalDir, "manifest.json"), "utf8"))).toMatchObject({ status: "failed", error: "network" });
  });
});
