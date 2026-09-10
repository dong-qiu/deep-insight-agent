import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function writeQueue(root: string): string {
  const queuePath = join(root, "review-queue.json");
  writeFileSync(queuePath, JSON.stringify({
    run_id: "a1-20260910150000-1a2b3c4d",
    generated_at: "2026-09-10T15:00:00Z",
    insights: [{
      id: "i-1", topic_id: "topic", type: "trend", importance: 3,
      statement: "A complete reader-visible statement.", importance_basis: "basis",
      citations: [{ content_item_id: "source-1", quote: "A complete reader-visible statement.", locator: { char_start: 0 } }],
    }],
  }));
  return queuePath;
}

function runCsv(...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "evals/make-review-csv.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

describe("review CSV blindness", () => {
  it("creates a human-only worksheet and rejects an AI prelabel argument", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-review-csv-")); roots.push(root);
    const queuePath = writeQueue(root);
    const blindCsvPath = join(root, "blind-review.csv");
    const normal = runCsv(queuePath, blindCsvPath);
    expect(normal.status).toBe(0);
    expect(readFileSync(blindCsvPath, "utf8")).not.toContain("AI预评");

    const prelabelPath = join(root, "prelabel.json");
    writeFileSync(prelabelPath, "[]\n");
    const blocked = runCsv(queuePath, join(root, "must-not-exist.csv"), prelabelPath);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("不能传入 AI 预标注");
  });
});
