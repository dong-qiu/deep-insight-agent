import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, openDb, type DB } from "./index.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { getContentItem, insertContentItem, insertSource } from "./repos.js";
import { planRawArchive, reconcileRawArchiveEffects, writePlannedRawArchive } from "./raw-archive.js";
import type { ContentItem, Source } from "../types.js";

const source: Source = { id: "source_raw", name: "raw", type: "rss", endpoint: "https://raw.test/feed", topic_ids: [], fetch_interval: "1h", backfill: null, enabled: true };
const item = (id: string): ContentItem => ({ id, source_id: source.id, url: `https://raw.test/${id}`, title: id, author: null,
  published_at: null, fetched_at: "2026-09-10T00:00:00.000Z", language: "en", topic_ids: [], tags: [], body: "body", body_kind: "article", raw_ref: "pending", content_hash: `hash-${id}`, fetch_status: "ok" });

let db: DB;
beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "raw-archive-test-"));
  db = openDb(":memory:"); applyProvenanceMigrations(db); insertSource(db, source);
});
afterEach(() => { closeDb(); delete process.env.DATA_DIR; delete process.env.DB_PATH; db.close(); });

describe("raw archive generation effects", () => {
  it("writes intent, stages, hashes, finalizes, and is idempotently reconciled", () => {
    insertContentItem(db, item("ci_raw_write"));
    const plan = planRawArchive(db, { contentId: "ci_raw_write", raw: "original raw" });
    expect(getContentItem(db, "ci_raw_write")).toBeNull();
    writePlannedRawArchive(db, plan, "original raw");
    expect(db.prepare("SELECT status FROM generation_effect WHERE id=?").get(plan.effectId)).toEqual({ status: "committed" });
    expect(getContentItem(db, "ci_raw_write")?.raw_ref).toBe(plan.rawRef);
    expect(reconcileRawArchiveEffects(db)).toEqual({ committed: 0, failed: 0 });
  });

  it("reconciles a crash after staging and before final rename", () => {
    insertContentItem(db, item("ci_raw_stage"));
    const plan = planRawArchive(db, { contentId: "ci_raw_stage", raw: "staged raw" });
    const staging = join(process.env.DATA_DIR!, "raw", ".staging", plan.effectId);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, plan.target), "staged raw");
    expect(reconcileRawArchiveEffects(db)).toEqual({ committed: 1, failed: 0 });
    expect(db.prepare("SELECT status FROM generation_effect WHERE id=?").get(plan.effectId)).toEqual({ status: "committed" });
    expect(getContentItem(db, "ci_raw_stage")?.raw_ref).toBe(plan.rawRef);
  });

  it("keeps a hash mismatch explainable across repeated reconciliation", () => {
    insertContentItem(db, item("ci_raw_bad"));
    const plan = planRawArchive(db, { contentId: "ci_raw_bad", raw: "expected raw" });
    const final = join(process.env.DATA_DIR!, "raw");
    mkdirSync(final, { recursive: true }); writeFileSync(join(final, plan.target), "tampered raw");
    expect(reconcileRawArchiveEffects(db)).toEqual({ committed: 0, failed: 1 });
    expect(reconcileRawArchiveEffects(db)).toEqual({ committed: 0, failed: 1 });
    const effect = db.prepare("SELECT status,error FROM generation_effect WHERE id=?").get(plan.effectId) as { status: string; error: string };
    expect(effect.status).toBe("unknown");
    expect(JSON.parse(effect.error)).toEqual({ reason_code: "raw_archive_final_hash_mismatch" });
    expect(getContentItem(db, "ci_raw_bad")).toBeNull();
  });

  it.each(["staged", "final"])("production startup finalizes only a verified %s artifact", (location) => {
    const dbPath = join(process.env.DATA_DIR!, `startup-${location}.sqlite`);
    db.close();
    db = openDb(dbPath); applyProvenanceMigrations(db); insertSource(db, source); insertContentItem(db, item(`ci_start_${location}`));
    const plan = planRawArchive(db, { contentId: `ci_start_${location}`, raw: "startup raw" });
    const rawRoot = join(process.env.DATA_DIR!, "raw");
    const artifactPath = location === "staged"
      ? join(rawRoot, ".staging", plan.effectId, plan.target)
      : join(rawRoot, plan.target);
    mkdirSync(artifactPath.slice(0, artifactPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(artifactPath, "startup raw");
    db.close();
    process.env.DB_PATH = dbPath;
    db = getDb();
    expect(db.prepare("SELECT status FROM generation_effect WHERE id=?").get(plan.effectId)).toEqual({ status: "committed" });
    expect(getContentItem(db, `ci_start_${location}`)?.raw_ref).toBe(plan.rawRef);
  });
});
