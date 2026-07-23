import { describe, expect, it } from "vitest";
import { extractLeadCandidates } from "../agents/tech-leads.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { openDb } from "./index.js";
import { insertContentItem, insertSource, insertTopic } from "./repos.js";
import { listTechLeadEvidence, listTechLeads, setTechLeadStatus, upsertTechLeads } from "./tech-leads.js";
import type { AnalysisBatch, ContentItem, Source, Topic, ValidationResult } from "../types.js";

const topic: Topic = { id: "t", name: "T", keywords: ["agent"], language: "en", brief_schedule: "daily", enabled: true };
const ci = (id: string): ContentItem => ({ id, source_id: "s", url: `https://x/${id}`, title: id, author: null, published_at: "2026-07-23T00:00:00Z", fetched_at: "2026-07-23T00:00:00Z", language: "en", topic_ids: ["t"], tags: [], body: "agent", body_kind: "article", raw_ref: "", content_hash: id, fetch_status: "ok" });

it("upsert 追加 pass 证据、保留用户忽略状态且读取证据可回溯", () => {
  const db = openDb(":memory:"); insertTopic(db, topic); insertSource(db, { id: "s", name: "Source", type: "rss", endpoint: "x", topic_ids: ["t"], fetch_interval: "6h", backfill: null, enabled: true } as Source); insertContentItem(db, ci("c"));
  const batch: AnalysisBatch = { id: "b", topic_id: "t", time_window: { start: "2026-07-22", end: "2026-07-23" }, status: "done", no_significant_event: false, insights: [{ id: "i", topic_id: "t", type: "aggregation", event_id: "e", statement: "Agent tool", headline: "Agent tool", importance: 4, importance_basis: "new", citations: [{ content_item_id: "c", quote: "agent", locator: { paragraph_index: 0, char_start: 0, char_end: 5 } }], source_count: 1, multi_source: false, time_window: { start: "2026-07-22", end: "2026-07-23" }, confidence: null, language: "en", tags: ["tool"] }] };
  const validation: ValidationResult = { checks: [{ insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
  saveAnalysisBatch(db, batch); saveValidationResult(db, "b", validation);
  const candidates = extractLeadCandidates(batch, validation, new Map([["c", ci("c")]]), "2026-07-23T01:00:00Z");
  const [lead] = upsertTechLeads(db, candidates, "2026-07-23T01:00:00Z");
  expect(listTechLeadEvidence(db, lead.id)).toMatchObject([{ source_name: "Source", url: "https://x/c", quote: "agent" }]);
  expect(setTechLeadStatus(db, lead.id, "dismissed")).toBe(true);
  upsertTechLeads(db, candidates, "2026-07-23T02:00:00Z");
  expect(listTechLeads(db)).toEqual([]);
  expect(listTechLeads(db, { includeDismissed: true })[0].status).toBe("dismissed");
  expect(listTechLeads(db, { includeDismissed: true, since: "2026-07-24T00:00:00Z" })).toEqual([]);
});
