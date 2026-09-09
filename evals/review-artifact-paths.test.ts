import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { latestReviewQueuePath } from "./review-artifact-paths.js";

describe("latest review artifact resolution", () => {
  it("uses only the isolated queue named by the completed-run pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-review-"));
    const runId = "a1-20260909140000-1a2b3c4d";
    mkdirSync(join(root, runId));
    writeFileSync(join(root, runId, "review-queue.json"), "{}\n");
    writeFileSync(join(root, "latest-complete.json"), JSON.stringify({ run_id: runId }));
    expect(latestReviewQueuePath(root)).toBe(join(root, runId, "review-queue.json"));
  });

  it("rejects a malformed pointer instead of resolving an arbitrary path", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-review-"));
    writeFileSync(join(root, "latest-complete.json"), JSON.stringify({ run_id: "../../outside" }));
    expect(() => latestReviewQueuePath(root)).toThrow("run_id 非法");
  });
});
