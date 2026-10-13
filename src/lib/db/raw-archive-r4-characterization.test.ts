import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConnection, type DB } from "./connection.js";
import { bootstrapLegacySchema } from "./legacy-bootstrap.js";
import { applyProvenanceMigrations } from "./migration-runner.js";
import { getContentItem, insertContentItem, insertSource } from "./repos.js";
import { planRawArchive, reconcileRawArchiveEffects, writePlannedRawArchive, type RawArchivePlan } from "./raw-archive.js";
import type { ContentItem, Source } from "../types.js";

// NOT RUN: private baseline characterization, no authority/qualification claim.
// Future gate: this file alone in an isolated Linux Vitest process, no parallel env writers.
const source: Source = { id: "r4_source", name: "r4", type: "rss", endpoint: "https://r4.invalid/feed",
  topic_ids: [], fetch_interval: "1h", backfill: null, enabled: true };
const contentId = "r4_content";
const raw = "R4 original archive: café\n";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const item: ContentItem = { id: contentId, source_id: source.id, url: "https://r4.invalid/content", title: "r4",
  author: null, published_at: null, fetched_at: "2026-10-13T00:00:00.000Z", language: "en", topic_ids: [],
  tags: [], body: "body", body_kind: "article", raw_ref: "pending", content_hash: "r4-fixture-body",
  fetch_status: "ok" };

// Per-test root and explicit DB path; no getDb/closeDb singleton access or default .data.
describe.sequential("R4 existing raw archive characterization", () => {
  let db: DB | undefined;
  let root: string | undefined;
  let setupComplete = false;
  let oldDataDir: string | undefined;
  let oldDbPath: string | undefined;

  beforeEach(() => {
    oldDataDir = process.env.DATA_DIR;
    oldDbPath = process.env.DB_PATH;
    setupComplete = false;
    db = undefined;
    root = mkdtempSync(join(tmpdir(), "r4-characterization-"));
    process.env.DATA_DIR = root;
    process.env.DB_PATH = join(root, "fixture.sqlite");
    db = openConnection(process.env.DB_PATH);
    // Faithful fresh legacy bootstrap; no startup singleton/orphan-recovery orchestration.
    bootstrapLegacySchema(db, true);
    applyProvenanceMigrations(db);
    insertSource(db, source);
    setupComplete = true;
  });

  afterEach(() => {
    // If setup/close fails, preserve this root; never report unknown close as clean disposal.
    let closed = false;
    try {
      if (db) {
        if (db.open) db.close();
        closed = !db.open;
        expect(closed).toBe(true);
      }
      if (setupComplete && closed && root) rmSync(root, { recursive: true, force: false });
    } finally {
      if (oldDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = oldDataDir;
      if (oldDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = oldDbPath;
    }
  });

  function fixtureDb(): DB {
    if (!db) throw new Error("r4_fixture_setup_incomplete");
    return db;
  }
  function planContent(): RawArchivePlan {
    const database = fixtureDb();
    // Real transaction return, not fabricated ACK or a safety wrapper.
    return database.transaction(() => {
      insertContentItem(database, item);
      return planRawArchive(database, { contentId, raw });
    })();
  }
  const rawRoot = () => join(root!, "raw");
  const finalPath = (plan: RawArchivePlan) => join(rawRoot(), plan.target);
  const stagedPath = (plan: RawArchivePlan) => join(rawRoot(), ".staging", plan.effectId, plan.target);
  function effectState(plan: RawArchivePlan) {
    return fixtureDb().prepare("SELECT status,error FROM generation_effect WHERE id=?").get(plan.effectId);
  }
  function effectCount() {
    return fixtureDb().prepare("SELECT COUNT(*) AS count FROM generation_effect WHERE kind='raw_archive'").get();
  }
  function pendingBinding(plan: RawArchivePlan) {
    expect(fixtureDb().prepare("SELECT raw_ref,reader_eligible FROM content_item WHERE id=?").get(contentId))
      .toEqual({ raw_ref: plan.rawRef, reader_eligible: 0 });
    expect(getContentItem(fixtureDb(), contentId)).toBeNull();
  }
  function visibleArtifact(plan: RawArchivePlan) {
    expect(readFileSync(finalPath(plan), "utf8")).toBe(raw);
    expect(plan.sha256).toBe(sha256(raw));
    expect(plan.size).toBe(Buffer.byteLength(raw, "utf8"));
    expect(statSync(finalPath(plan)).size).toBe(plan.size);
    expect(effectState(plan)).toEqual({ status: "committed", error: null });
    expect(fixtureDb().prepare("SELECT raw_ref,reader_eligible FROM content_item WHERE id=?").get(contentId))
      .toEqual({ raw_ref: plan.rawRef, reader_eligible: 1 });
    expect(getContentItem(fixtureDb(), contentId)?.raw_ref).toBe(plan.rawRef);
    expect(effectCount()).toEqual({ count: 1 });
  }

  it("P1 commits a real binding and exact UTF8 artifact before reader visibility", () => {
    const plan = planContent();
    pendingBinding(plan);
    expect(existsSync(finalPath(plan))).toBe(false);
    writePlannedRawArchive(fixtureDb(), plan, raw);
    visibleArtifact(plan);
    const before = statSync(finalPath(plan));
    expect(reconcileRawArchiveEffects(fixtureDb())).toEqual({ committed: 0, failed: 0 });
    expect(statSync(finalPath(plan)).ino).toBe(before.ino);
    visibleArtifact(plan);
  });

  it("N4 matching replan retains one effect and closes visibility until reverified", () => {
    const original = planContent();
    writePlannedRawArchive(fixtureDb(), original, raw);
    const replay = fixtureDb().transaction(() => planRawArchive(fixtureDb(), { contentId, raw }))();
    expect(replay).toEqual(original);
    pendingBinding(replay);
    expect(effectCount()).toEqual({ count: 1 });
    writePlannedRawArchive(fixtureDb(), replay, raw);
    visibleArtifact(replay);
  });

  it("N4 direct committed-plan rewrite throws but retains physical publication and committed state", () => {
    const plan = planContent();
    writePlannedRawArchive(fixtureDb(), plan, raw);
    const before = statSync(finalPath(plan));
    // Characterizes baseline failure, NOT a safe/idempotent replay endorsement.
    expect(() => writePlannedRawArchive(fixtureDb(), plan, raw)).toThrow("raw_archive_content_binding_missing");
    const after = statSync(finalPath(plan));
    expect(after.dev).toBe(before.dev);
    expect(after.ino).not.toBe(before.ino); // New staged inode renamed over an existing live file (Linux gate).
    visibleArtifact(plan); // Catch must not invent rollback of the previous committed fact.
    expect(reconcileRawArchiveEffects(fixtureDb())).toEqual({ committed: 0, failed: 0 });
  });

  it("N4 rejects wrong payload and changed plan identity before attempted/file effects", () => {
    const plan = planContent();
    expect(() => writePlannedRawArchive(fixtureDb(), plan, "different raw")).toThrow("raw_archive_payload_mismatch");
    expect(() => writePlannedRawArchive(fixtureDb(), { ...plan, target: `other.${plan.sha256}.txt` }, raw))
      .toThrow("raw_archive_payload_mismatch");
    expect(effectState(plan)).toEqual({ status: "planned", error: null });
    expect(effectCount()).toEqual({ count: 1 });
    expect(existsSync(rawRoot())).toBe(false);
    pendingBinding(plan);
  });

  it("N5 preserves missing-artifact unknown across repeated reconciliation", () => {
    const plan = planContent();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(reconcileRawArchiveEffects(fixtureDb())).toEqual({ committed: 0, failed: 1 });
      expect(effectState(plan)).toEqual({ status: "unknown", error: JSON.stringify({ reason_code: "raw_archive_artifact_missing" }) });
      expect(existsSync(finalPath(plan))).toBe(false);
      expect(existsSync(stagedPath(plan))).toBe(false);
      expect(existsSync(rawRoot())).toBe(false);
      expect(effectCount()).toEqual({ count: 1 });
      pendingBinding(plan);
    }
  });

  it("N5 corrupt staging remains diagnostic without final publication or reader visibility", () => {
    const plan = planContent();
    const badRaw = "tampered staged bytes";
    mkdirSync(join(rawRoot(), ".staging", plan.effectId), { recursive: true });
    writeFileSync(stagedPath(plan), badRaw);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(reconcileRawArchiveEffects(fixtureDb())).toEqual({ committed: 0, failed: 1 });
      expect(effectState(plan)).toEqual({ status: "unknown", error: JSON.stringify({ reason_code: "raw_archive_staging_hash_mismatch" }) });
      expect(readFileSync(stagedPath(plan), "utf8")).toBe(badRaw);
      expect(existsSync(finalPath(plan))).toBe(false);
      expect(readdirSync(join(rawRoot(), ".staging", plan.effectId))).toEqual([plan.target]);
      expect(effectCount()).toEqual({ count: 1 });
      pendingBinding(plan);
    }
  });
});
