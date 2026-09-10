import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function runPrepare(...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "evals/prepare-controlled-v2-snapshot.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

function qualityLine(id: string, url: string, body: string) {
  return JSON.stringify({ topic: { id: "topic" }, items: [{ id, source_id: "src", url, body, content_hash: "source-hash", fetched_at: "2026-09-10T00:00:00Z" }] });
}

describe("controlled v2 source snapshot preparation", () => {
  it("writes item/URL/body-hash provenance without copying source body into the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    const body = "source body must stay out of the manifest";
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/one", body)}\n`);
    const outDir = join(root, "candidate");
    const result = runPrepare(qualityPath, outDir, "a1-v2-candidate");
    expect(result.status).toBe(0);
    const text = readFileSync(join(outDir, "source-manifest.json"), "utf8");
    expect(text).not.toContain(body);
    expect(JSON.parse(text)).toMatchObject({
      status: "candidate_pending_labels",
      quality_input: { sha256: createHash("sha256").update(readFileSync(qualityPath)).digest("hex"), item_count: 1 },
      items: [{ content_item_id: "item-1", body_sha256: createHash("sha256").update(body).digest("hex") }],
    });
  });

  it("rejects duplicate URLs before creating a misleading candidate manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/one", "first")}\n${qualityLine("item-2", "https://example.test/one", "second")}\n`);
    const result = runPrepare(qualityPath, join(root, "candidate"), "a1-v2-candidate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("重复 content id 或 URL");
  });
});
