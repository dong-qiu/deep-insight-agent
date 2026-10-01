import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, openDb, type DB } from "./index.js";
import { getReport, saveReport } from "./reports.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";
import { getContentItem, insertContentItem, insertSource, insertTopic } from "./repos.js";
import { markRawArchiveUnknown, planRawArchive, reconcileRawArchiveEffects, writePlannedRawArchive } from "./raw-archive.js";
import { contentHash } from "../sources/normalize.js";
import type { ContentItem, Report, ReportIndexEntry, Source } from "../types.js";

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
  it("persists only known archive reason codes, never arbitrary filesystem error details", () => {
    insertContentItem(db, item("ci_private_error"));
    const plan = planRawArchive(db, { contentId: "ci_private_error", raw: "original raw" });
    markRawArchiveUnknown(db, plan.effectId, "synthetic-private-filesystem-path");
    const row = db.prepare("SELECT error FROM generation_effect WHERE id=?").get(plan.effectId) as { error: string };
    expect(JSON.parse(row.error)).toEqual({ reason_code: "raw_archive_write_failed" });
    expect(row.error).not.toContain("synthetic-private");
    expect(getContentItem(db, "ci_private_error")).toBeNull();
  });
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

  it("startup restores a pending source archive before resuming its dependent report", () => {
    const dbPath = join(process.env.DATA_DIR!, "source-before-report.sqlite");
    db.close();
    db = openDb(dbPath);
    applyProvenanceMigrations(db);
    insertTopic(db, { id: "t_recovery", name: "Recovery", keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true });
    insertSource(db, source);
    const body = "recovery quote";
    insertContentItem(db, { ...item("ci_report_recovery"), topic_ids: ["t_recovery"], body, content_hash: contentHash(body), raw_ref: "" });
    const archive = (sourceItemRaw: string) => `${JSON.stringify({ schema_version: "content-raw-archive-v1",
      source_body_origin: "feed", source_body: body, source_body_kind: "article", source_item_raw: sourceItemRaw,
      structured_body_sha256: contentHash(body) })}\n`;
    const first = archive("<item>initial</item>");
    writePlannedRawArchive(db, planRawArchive(db, { contentId: "ci_report_recovery", raw: first }), first);
    db.prepare("INSERT INTO analysis_batch(id,topic_id,time_window,status) VALUES ('b_recovery','t_recovery','{}','done')").run();
    db.prepare(`INSERT INTO insight(id,batch_id,topic_id,type,statement,statement_citation_index,importance,importance_basis,source_count,multi_source,time_window,language)
      VALUES ('i_recovery','b_recovery','t_recovery','aggregation',?,1,3,'test',1,0,'{}','en')`).run(body);
    db.prepare("INSERT INTO citation(insight_id,citation_index,content_item_id,quote,locator) VALUES ('i_recovery',0,'ci_report_recovery',?,'{}')").run(body);
    db.prepare(`INSERT INTO citation_check(batch_id,insight_id,citation_index,reachability,reachability_reason,consistency,consistency_reason,verdict)
      VALUES ('b_recovery','i_recovery',0,'pass','ok','support','ok','pass')`).run();
    const report: Report = { id: "rep_startup_recovery", type: "brief", topic_id: "t_recovery", status: "done",
      generated_at: "2026-10-01T00:00:00Z", title: "Recovery", body_md: `${body} [1]`, body_html: `<p>${body} [1]</p>`,
      insight_ids: ["i_recovery"], event_ids: [], prev_report_id: null, citation_count: 1,
      cost: { tokens: 0, amount: 0 } };
    const index: ReportIndexEntry = { report_id: report.id, type: report.type, topic_id: report.topic_id, facets: [],
      date: "2026-10-01", source_ids: [source.id], title: report.title, summary: body, highlights: [], tags: [],
      entity_names: [], importance: 3, event_ids: [], milestone_count: 0 };
    expect(() => saveReport(db, report, index, { readerCitationBindings: [{ insight_id: "i_recovery", citation_index: 0 }],
      afterPublish: () => { throw new Error("simulated_crash"); } })).toThrow("simulated_crash");
    db.prepare("UPDATE report SET status='generating',failure=NULL WHERE id=?").run(report.id);

    const replacement = archive("<item>same source text, newer fetched bytes</item>");
    const planned = planRawArchive(db, { contentId: "ci_report_recovery", raw: replacement });
    const staging = join(process.env.DATA_DIR!, "raw", ".staging", planned.effectId);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, planned.target), replacement);
    expect(getContentItem(db, "ci_report_recovery")).toBeNull();
    db.close();
    process.env.DB_PATH = dbPath;
    db = getDb();
    expect(getContentItem(db, "ci_report_recovery")?.raw_ref).toBe(planned.rawRef);
    expect(getReport(db, report.id)?.status).toBe("done");
  });
});
