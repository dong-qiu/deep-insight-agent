import { describe, expect, it } from "vitest";
import { extractLeadCandidates } from "../agents/tech-leads.js";
import { saveAnalysisBatch, saveValidationResult } from "./analysis.js";
import { openDb } from "./index.js";
import { insertContentItem, insertSource, insertTopic } from "./repos.js";
import { getTechLead, listTechLeadEvidence, listTechLeads, setTechLeadStatus, upsertTechLeads } from "./tech-leads.js";
import type { AnalysisBatch, ContentItem, Source, Topic, ValidationResult } from "../types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";

const topic: Topic = { id: "t", name: "T", keywords: ["agent"], language: "en", brief_schedule: "daily", enabled: true };
const ci = (id: string): ContentItem => ({ id, source_id: "s", url: `https://x/${id}`, title: id, author: null, published_at: "2026-07-23T00:00:00Z", fetched_at: "2026-07-23T00:00:00Z", language: "en", topic_ids: ["t"], tags: [], body: "agent", body_kind: "article", raw_ref: "", content_hash: id, fetch_status: "ok" });

it("upsert 追加 pass 证据、保留用户忽略状态且读取证据可回溯", () => {
  const db = openDb(":memory:"); insertTopic(db, topic); insertSource(db, { id: "s", name: "Source", type: "rss", endpoint: "x", topic_ids: ["t"], fetch_interval: "6h", backfill: null, enabled: true } as Source); insertContentItem(db, ci("c"));
  const batch: AnalysisBatch = { id: "b", topic_id: "t", time_window: { start: "2026-07-22", end: "2026-07-23" }, status: "done", no_significant_event: false, insights: [{ id: "i", topic_id: "t", type: "aggregation", event_id: "e", statement: "Agent tool", statement_citation_index: 1, headline: "", importance: 4, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", citations: [{ content_item_id: "c", citation_ref: "binding", claim: "Agent tool", quote: "Agent tool", locator: { paragraph_index: 0, char_start: 0, char_end: 10 } }], source_count: 1, multi_source: false, time_window: { start: "2026-07-22", end: "2026-07-23" }, confidence: null, language: "en", tags: ["tool"] }], display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION, display_coverage_audits: [{ insight_id: "i", candidate_id: "i", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage", decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash("Agent tool"), quote_sha256: sourceQuoteHash("Agent tool"), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-09T00:00:00Z" }] };
  const validation: ValidationResult = { checks: [{ insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" }], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
  saveAnalysisBatch(db, batch); saveValidationResult(db, "b", validation);
  const candidates = extractLeadCandidates(batch, validation, new Map([["c", ci("c")]]), "2026-07-23T01:00:00Z");
  const [lead] = upsertTechLeads(db, candidates, "2026-07-23T01:00:00Z");
  expect(listTechLeadEvidence(db, lead.id)).toMatchObject([{ source_name: "Source", url: "https://x/c", quote: "Agent tool" }]);
  // A durable candidate can contain old free prose.  One current v6 evidence binding must not
  // make that prose reader-visible, nor duplicate its binding quote in the combined API payload.
  db.prepare("UPDATE tech_lead SET title='Hallucinated acquisition',summary='Unbound claim',score_detail=? WHERE id=?")
    .run(JSON.stringify({ freshness: 1, evidence: 1, importance: 1, relevance: 1, total: 4, reason: "3 个独立来源证实收购" }), lead.id);
  const projected = listTechLeads(db, { includeDismissed: true });
  expect(projected).toMatchObject([{
    id: lead.id, kind: "other", title: "已核验技术线索", summary: "请展开下方已核验原文与来源。",
    score_detail: { reason: "系统优先级评分：基于当前已核验原文与时间信息。" },
  }]);
  expect(getTechLead(db, lead.id)).toMatchObject({ title: "已核验技术线索", summary: "请展开下方已核验原文与来源。" });
  const readerPayload = JSON.stringify({ lead: projected[0], evidence: listTechLeadEvidence(db, lead.id) });
  expect(readerPayload.split("Agent tool").length - 1).toBe(1);
  expect(readerPayload).not.toContain("Hallucinated acquisition");
  expect(readerPayload).not.toContain("Unbound claim");
  expect(readerPayload).not.toContain("3 个独立来源");
  db.prepare("UPDATE citation_check SET consistency='uncertain' WHERE insight_id='i' AND citation_index=0").run();
  expect(listTechLeadEvidence(db, lead.id)).toEqual([]); // 防御异常 pass + non-support 不能从已落库证据复活
  expect(setTechLeadStatus(db, lead.id, "dismissed")).toBe(true);
  upsertTechLeads(db, candidates, "2026-07-23T02:00:00Z");
  expect(listTechLeads(db)).toEqual([]);
  expect(listTechLeads(db, { includeDismissed: true })).toEqual([]); // no stale lead is reader-visible, including dismissed history
  expect(listTechLeads(db, { includeDismissed: true, since: "2026-07-24T00:00:00Z" })).toEqual([]);
});
