import { saveAnalysisBatch, saveValidationResult } from "../../src/lib/db/analysis.js";
import { openDb } from "../../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../../src/lib/db/provenance-migrations.js";
import { upsertTechnologyOpportunities } from "../../src/lib/db/planning.js";
import { planRawArchive, writePlannedRawArchive } from "../../src/lib/db/raw-archive.js";
import { insertContentItem, insertSource, insertTopic } from "../../src/lib/db/repos.js";
import { upsertTechLeads } from "../../src/lib/db/tech-leads.js";
import { upsertUser } from "../../src/lib/db/users.js";
import { contentHash } from "../../src/lib/sources/normalize.js";
import type { AnalysisBatch, Insight, ValidationResult } from "../../src/lib/types.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../../src/lib/utils/source-quote-projection.js";

export const viewer = { email: "smoke@example.test", password: "synthetic-smoke-password" };
export const statement = "Atlas 和 Beacon 发布合成工具。";
export const hypothesis = "待验证假设：合成工具适合本地 PoC。";
export const sourceUrl = "https://example.test/synthetic-tool";

/** Same v6 audit + committed v1 archive contract as the existing graph/reader E2E. */
export function seedBrowserDb(dbPath: string, missingArchive = false): { observedDate: string } {
  const db = openDb(dbPath);
  try {
    applyProvenanceMigrations(db);
    for (const [id, name] of [["smoke-main", "合成工具"], ["smoke-sparse", "单次共现"], ["smoke-empty", "空主题"]]) {
      insertTopic(db, { id, name, keywords: ["tool"], language: "zh", brief_schedule: "daily", enabled: true });
    }
    insertSource(db, { id: "smoke-source", name: "合成来源", type: "rss", endpoint: "https://example.test/feed",
      topic_ids: ["smoke-main", "smoke-sparse"], fetch_interval: "6h", backfill: null, enabled: true });
    const recent = new Date(Date.now() - 86400000).toISOString();
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    const addBatch = (id: string, topicId: string, text: string, names: string[], at: string, count: number) => {
      const contentId = `content-${id}`;
      insertContentItem(db, { id: contentId, source_id: "smoke-source", url: id === "recent" ? sourceUrl : `https://example.test/${id}`,
        title: "合成工具公告", author: null, published_at: at, fetched_at: at, language: "zh", topic_ids: [topicId], tags: [],
        body: text, body_kind: "article", raw_ref: "", content_hash: contentHash(text), fetch_status: "ok" });
      if (!missingArchive) {
        const raw = `${JSON.stringify({ schema_version: "content-raw-archive-v1", source_body_origin: "feed", source_body: text,
          source_body_kind: "article", source_item_raw: "<item>synthetic</item>", structured_body_sha256: contentHash(text) })}\n`;
        writePlannedRawArchive(db, planRawArchive(db, { contentId, raw }), raw);
      }
      const insights: Insight[] = Array.from({ length: count }, (_, index) => ({
        id: `${id}-${index}`, topic_id: topicId, type: "aggregation", event_id: `${id}-${index}`,
        statement: text, statement_citation_index: 1, headline: "", importance: 4,
        importance_basis: "系统重要性判断：该结果可为工程选型提供参考。",
        citations: [{ content_item_id: contentId, citation_ref: `${id}-binding-${index}`, claim: text, quote: text,
          locator: { paragraph_index: 0, char_start: 0, char_end: text.length } }],
        source_count: 1, multi_source: false, time_window: { start: at, end: at }, confidence: null, language: "zh",
        is_followup: false, entities: names.map(name => ({ name, type: "organization" })), tags: [],
      }));
      const batch: AnalysisBatch = { id, topic_id: topicId, time_window: { start: at, end: at }, status: "done",
        no_significant_event: false, insights, display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION,
        display_coverage_audits: insights.map(insight => ({
          insight_id: insight.id, candidate_id: insight.id, gate_version: "display-coverage-v6", terminal_reason: "kept",
          prompt_version: "display-coverage-v6", input_hash: `synthetic-${insight.id}`, validator_model: "synthetic-validator", created_at: at,
          decision: { statement_citation_index: 1, statement_citation_ref: insight.citations[0]!.citation_ref,
            display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash(text), quote_sha256: sourceQuoteHash(text),
            claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true,
              citation_indexes: [1], countercheck: { supports: true } }] },
        })),
      };
      saveAnalysisBatch(db, batch);
      // The graph's time window is batch.created_at, not insight.time_window.
      db.prepare("UPDATE analysis_batch SET created_at=? WHERE id=?").run(at.replace("T", " ").slice(0, 19), id);
      const validation: ValidationResult = { checks: insights.map(insight => ({ insight_id: insight.id, citation_index: 0,
        reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" })),
        report: { total: count, pass: count, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0,
          insights_total: count, insights_includable: count, releasable: true } };
      saveValidationResult(db, id, validation);
      return insights;
    };
    const recentInsights = addBatch("recent", "smoke-main", statement, ["Atlas", "Beacon"], recent, 2);
    addBatch("old", "smoke-main", "Cedar 和 Delta 发布合成工具。", ["Cedar", "Delta"], old, 1);
    addBatch("sparse", "smoke-sparse", "Echo 和 Foxtrot 发布合成工具。", ["Echo", "Foxtrot"], recent, 1);
    const [lead] = upsertTechLeads(db, [{ topic_id: "smoke-main", canonical_key: "synthetic-tool", kind: "tool",
      title: "合成工具", summary: statement, evidence: recentInsights.map(insight => ({ insight_id: insight.id, citation_index: 0 })),
      observed_at: recent, score: 82, score_detail: { freshness: 30, evidence: 20, importance: 16, relevance: 16, total: 82, reason: "synthetic" } }], recent);
    upsertTechnologyOpportunities(db, [{ lead_id: lead!.id, topic_id: "smoke-main", direction_id: null,
      canonical_key: "synthetic-opportunity", lane: "horizon", planning_effect: "new_direction", title: "合成机会", hypothesis,
      proposed_validation: "在隔离环境运行合成 PoC。", uncertainties: ["适用范围待验证"], priority_score: 82,
      score_detail: { alignment: 16, evidence: 20, leverage: 16, verifiability: 20, timing: 10, total: 82, reason: "synthetic" },
      fit_score: 0, rationale: "synthetic", mapping_direction_version: null }], new Map([[lead!.id, lead!]]), recent);
    upsertUser(db, viewer.email, viewer.password, "viewer");
    return { observedDate: recent.slice(0, 10) };
  } finally { db.close(); }
}
