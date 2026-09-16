import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash, normalizeBody } from "../src/lib/sources/normalize.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function runPrepare(...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "evals/prepare-controlled-v2-snapshot.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function writeRawArchive(root: string, id: string, body: string, options: { sourceBody?: string; origin?: string } = {}) {
  const sourceBody = options.sourceBody ?? body;
  const path = join(root, `${id}.raw.json`);
  writeFileSync(path, `${JSON.stringify({
    schema_version: "content-raw-archive-v1",
    source_body_origin: options.origin ?? "feed",
    source_body: sourceBody,
    ...(options.origin === "article_page" ? { article_html: `<html><body>${sourceBody}</body></html>` } : {}),
    structured_body_sha256: contentHash(body),
  })}\n`);
  return path;
}

function qualityLine(id: string, url: string, body: string, rawRef: string, options: { fetchStatus?: string; contentHash?: string } = {}) {
  return JSON.stringify({
    topic: { id: "topic" },
    items: [{
      id, source_id: "src", url, body, raw_ref: rawRef,
      content_hash: options.contentHash ?? contentHash(body), fetch_status: options.fetchStatus ?? "ok",
      fetched_at: "2026-09-10T00:00:00Z",
    }],
  });
}

describe("controlled v2 source snapshot preparation", () => {
  it("writes item/URL/body-hash provenance without copying source body into the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    const body = "source body must stay out of the manifest";
    const rawRef = writeRawArchive(root, "item-1", body);
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/one", body, rawRef)}\n`);
    const evidencePath = join(root, "collection.json");
    writeFileSync(evidencePath, "{\"outcome\":\"collected\"}\n");
    const outDir = join(root, "candidate");
    const result = runPrepare(qualityPath, outDir, "a1-v2-candidate", evidencePath);
    expect(result.status).toBe(0);
    const text = readFileSync(join(outDir, "source-manifest.json"), "utf8");
    expect(text).not.toContain(body);
    expect(JSON.parse(text)).toMatchObject({
      schema_version: "a1-controlled-source-snapshot-v2",
      status: "candidate_pending_labels",
      quality_input: { sha256: createHash("sha256").update(readFileSync(qualityPath)).digest("hex"), item_count: 1 },
      collection_evidence: [{ name: "collection.json", sha256: createHash("sha256").update(readFileSync(evidencePath)).digest("hex") }],
      items: [{
        content_item_id: "item-1", body_sha256: createHash("sha256").update(body).digest("hex"),
        raw_archive_sha256: hash(readFileSync(rawRef)), raw_archive_byte_length: readFileSync(rawRef).length,
        source_body_origin: "feed",
      }],
    });
  });

  it("rejects duplicate URLs before creating a misleading candidate manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    const first = writeRawArchive(root, "item-1", "first");
    const second = writeRawArchive(root, "item-2", "second");
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/one", "first", first)}\n${qualityLine("item-2", "https://example.test/one", "second", second)}\n`);
    const result = runPrepare(qualityPath, join(root, "candidate"), "a1-v2-candidate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("重复 content id 或 URL");
  });

  it("rejects a partial source before creating a candidate manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    const rawRef = writeRawArchive(root, "partial", "feed fallback");
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/one", "feed fallback", rawRef, { fetchStatus: "partial" })}\n`);
    const result = runPrepare(qualityPath, join(root, "candidate"), "a1-v2-candidate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fetch_status 必须为 ok");
  });

  it("rejects a missing or body-inconsistent raw archive", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const missingQuality = join(root, "missing.local.jsonl");
    writeFileSync(missingQuality, `${qualityLine("item-1", "https://example.test/one", "body", join(root, "missing.raw"))}\n`);
    const missing = runPrepare(missingQuality, join(root, "missing-candidate"), "a1-v2-candidate");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("缺少可读取的 raw_ref");

    const inconsistentQuality = join(root, "inconsistent.local.jsonl");
    const rawRef = writeRawArchive(root, "inconsistent", "different source body");
    writeFileSync(inconsistentQuality, `${qualityLine("item-2", "https://example.test/two", "expected body", rawRef)}\n`);
    const inconsistent = runPrepare(inconsistentQuality, join(root, "inconsistent-candidate"), "a1-v2-candidate");
    expect(inconsistent.status).toBe(1);
    expect(inconsistent.stderr).toContain("绑定不一致");
  });

  it("accepts source markup whose normalized body contains a nested HTML entity", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-snapshot-")); roots.push(root);
    const qualityPath = join(root, "quality.local.jsonl");
    // One pass turns &amp;lt; into &lt;. Re-normalizing that stored text turns it into <, so a
    // direct contentHash(sourceBody) comparison would be a false integrity failure.
    const sourceBody = "<p>literal &amp;lt; marker</p>";
    const body = normalizeBody(sourceBody);
    const rawRef = writeRawArchive(root, "nested-entity", body, { sourceBody });
    writeFileSync(qualityPath, `${qualityLine("item-1", "https://example.test/entity", body, rawRef)}\n`);

    const result = runPrepare(qualityPath, join(root, "candidate"), "a1-v2-candidate");
    expect(result.status).toBe(0);
  });
});
