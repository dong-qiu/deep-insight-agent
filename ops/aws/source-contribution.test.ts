import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { AnalysisBatch, ContentItem, Report, ReportIndexEntry, Source, Topic } from "../../src/lib/types.js";
import { saveAnalysisBatch } from "../../src/lib/db/analysis.js";
import { openDb } from "../../src/lib/db/index.js";
import { saveReport } from "../../src/lib/db/reports.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("cited aggregation excludes pending raw-archive content", () => {
  const dir = mkdtempSync(join(tmpdir(), "ia-source-contribution-"));
  dirs.push(dir);
  const db = openDb(join(dir, "insight.db"));
  const now = new Date().toISOString();
  const topic: Topic = { id: "t1", name: "T", keywords: [], language: "zh", brief_schedule: "daily", enabled: true };
  const source: Source = { id: "src_pending", name: "pending", type: "rss", endpoint: "https://pending.test", topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true };
  const content: ContentItem = { id: "ci_pending", source_id: source.id, url: "https://pending.test/item", title: "pending", author: null, published_at: null, fetched_at: now, language: "en", topic_ids: ["t1"], tags: [], body: "body", body_kind: "article", raw_ref: "raw/pending", content_hash: "pending", fetch_status: "ok" };
  const insight = { id: "ins_pending", topic_id: topic.id, type: "aggregation" as const, event_id: null, statement: "pending", headline: "", importance: 1, importance_basis: "test", citations: [{ content_item_id: content.id, quote: "body", locator: { paragraph_index: 0, char_start: 0, char_end: 4 } }], source_count: 1, multi_source: false, time_window: { start: now.slice(0, 10), end: now.slice(0, 10) }, confidence: null, language: "zh" as const, is_followup: false, entities: [], tags: [] };
  const batch: AnalysisBatch = { id: "batch_pending", topic_id: topic.id, time_window: insight.time_window, status: "done", no_significant_event: false, insights: [insight] };
  const report: Report = { id: "report_pending", type: "brief", topic_id: topic.id, status: "done", generated_at: now, title: "pending", body_md: "", body_html: "", insight_ids: [insight.id], event_ids: [], prev_report_id: null, citation_count: 1, cost: { tokens: 0, amount: 0 } };
  const reportIndex: ReportIndexEntry = { report_id: report.id, type: report.type, topic_id: topic.id, date: now.slice(0, 10), source_ids: [source.id], title: report.title, summary: "", highlights: [], tags: [], entity_names: [], importance: 1, event_ids: [], milestone_count: 0 };
  insertTopic(db, topic); insertSource(db, source); insertContentItem(db, content);
  saveAnalysisBatch(db, batch); saveReport(db, report, reportIndex, { dir });
  db.prepare("UPDATE content_item SET reader_eligible=0 WHERE id=?").run(content.id);
  db.close();

  const scriptPath = fileURLToPath(new URL("./source-contribution.sh", import.meta.url));
  const script = readFileSync(scriptPath, "utf8");
  const query = script.match(/read -r -d '' QUERY <<'JS' \|\| true\n([\s\S]*?)\nJS\n/)?.[1];
  expect(query).toBeTruthy();
  const output = execFileSync(process.execPath, ["-e", query!.replace("'/data/insight.db'", JSON.stringify(join(dir, "insight.db"))), "source-contribution-query", "7", topic.id, "14", ""], { cwd: process.cwd(), encoding: "utf8" });
  expect(output).toMatch(/pending\s+1\s+0\s+0/);
});
