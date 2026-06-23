/** 按源贡献聚合（ADR-0008 决定⑦ 切片4）：report(done)→insight→citation→content_item.source_id
 *  读时聚合每源被引用的 distinct 洞察数。multi-source 洞察对每被引源各计 1（计数口径）。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import type { AnalysisBatch, ContentItem, Report, ReportIndexEntry, Source, Topic } from "../types.js";
import { saveAnalysisBatch } from "./analysis.js";
import { type DB, openDb } from "./index.js";
import { saveReport } from "./reports.js";
import { insertContentItem, insertSource, insertTopic, sourceContribution } from "./repos.js";

const dir = mkdtempSync(join(tmpdir(), "ia-contrib-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const src = (id: string): Source => ({
  id, name: id, type: "rss", endpoint: "e", topic_ids: ["t1"],
  fetch_interval: "1h", backfill: null, enabled: true,
});
const topic: Topic = { id: "t1", name: "T", keywords: [], language: "zh", brief_schedule: "daily", enabled: true };
const ci = (id: string, source_id: string): ContentItem => ({
  id, source_id, url: `https://x/${id}`, title: "T", author: null, published_at: null,
  fetched_at: "2026-05-25T00:00:00Z", language: "en", topic_ids: ["t1"], tags: [], body: "b",
  body_kind: "article", raw_ref: "r", content_hash: id, fetch_status: "ok",
});
const ins = (id: string, citeItems: string[]) => ({
  id, topic_id: "t1", type: "aggregation" as const, event_id: null, statement: id, headline: "",
  importance: 4, importance_basis: "x",
  citations: citeItems.map((cid, i) => ({ content_item_id: cid, quote: "q", locator: { paragraph_index: 0, char_start: i, char_end: i + 1 } })),
  source_count: citeItems.length, multi_source: citeItems.length > 1,
  time_window: { start: "2026-05-01", end: "2026-05-07" }, confidence: null, language: "zh" as const,
  is_followup: false, entities: [], tags: [],
});
const index = (rid: string): ReportIndexEntry => ({
  report_id: rid, type: "brief", topic_id: "t1", date: "2026-06-20",
  source_ids: [], title: "T", summary: "s", highlights: [], tags: [], entity_names: [], importance: 4, event_ids: [], milestone_count: 0,
});
const report = (rid: string, insight_ids: string[], status: Report["status"], generated_at: string): Report => ({
  id: rid, type: "brief", topic_id: "t1", status, generated_at, title: "T",
  body_md: "m", body_html: "h", insight_ids, event_ids: [], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 },
});

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  insertTopic(db, topic);
  insertSource(db, src("src_a"));
  insertSource(db, src("src_b"));
  insertContentItem(db, ci("ci1", "src_a"));
  insertContentItem(db, ci("ci2", "src_b"));
  // i1 引 ci1(src_a)；i2 引 ci1+ci2(src_a+src_b，multi-source)
  const batch: AnalysisBatch = {
    id: "b1", topic_id: "t1", time_window: { start: "2026-05-01", end: "2026-05-07" }, status: "done",
    no_significant_event: false, insights: [ins("i1", ["ci1"]), ins("i2", ["ci1", "ci2"])],
  };
  saveAnalysisBatch(db, batch);
});

it("已上报报告里：src_a 被 i1+i2 引（2），src_b 被 i2 引（1）", () => {
  saveReport(db, report("rep1", ["i1", "i2"], "done", "2026-06-20T08:00:00Z"), index("rep1"), { dir });
  const c = sourceContribution(db, "2026-06-01T00:00:00Z");
  expect(c.get("src_a")).toBe(2); // distinct 洞察 {i1,i2}
  expect(c.get("src_b")).toBe(1); // distinct 洞察 {i2}（multi-source 各源计 1）
});

it("失败报告不计入", () => {
  saveReport(db, report("rep_fail", ["i1", "i2"], "failed", "2026-06-20T08:00:00Z"), index("rep_fail"), { dir });
  const c = sourceContribution(db, "2026-06-01T00:00:00Z");
  expect(c.size).toBe(0);
});

it("窗口外（since 之前）的报告不计入", () => {
  saveReport(db, report("rep_old", ["i1"], "done", "2026-05-01T08:00:00Z"), index("rep_old"), { dir });
  expect(sourceContribution(db, "2026-06-01T00:00:00Z").size).toBe(0);
});

it("未被任何上报报告引用的源 → 不在 map（调用方默认 0）", () => {
  saveReport(db, report("rep2", ["i1"], "done", "2026-06-20T08:00:00Z"), index("rep2"), { dir }); // 只引 i1(src_a)
  const c = sourceContribution(db, "2026-06-01T00:00:00Z");
  expect(c.get("src_a")).toBe(1);
  expect(c.has("src_b")).toBe(false); // src_b 未被引 → 不在 map
});
