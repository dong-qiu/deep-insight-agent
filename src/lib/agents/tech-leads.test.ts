import { describe, expect, it } from "vitest";
import type { AnalysisBatch, ContentItem, ValidationResult } from "../types.js";
import { classifyTechLead, extractLeadCandidates, isTechnicalLead, scoreLead } from "./tech-leads.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "../utils/source-quote-projection.js";

const batch: AnalysisBatch = { id: "b", topic_id: "t", time_window: { start: "2026-07-21", end: "2026-07-23" }, status: "done", no_significant_event: false, insights: [{
  id: "i", topic_id: "t", type: "aggregation", event_id: "evt_model", statement: "A new model release is announced", headline: "", importance: 5, importance_basis: "系统重要性判断：该结果可为工程选型提供参考。", source_count: 2, multi_source: true,
  statement_citation_index: 1,
  citations: [{ content_item_id: "a", citation_ref: "binding", claim: "A new model release is announced", quote: "A new model release is announced", locator: { paragraph_index: 0, char_start: 0, char_end: 31 } }, { content_item_id: "b", quote: "model", locator: { paragraph_index: 0, char_start: 0, char_end: 5 } }],
  time_window: { start: "2026-07-21", end: "2026-07-23" }, confidence: null, language: "en", tags: ["model"], entities: [{ name: "Model X", type: "product" }],
}], display_coverage_state: "audited", display_projection_version: DISPLAY_PROJECTION_VERSION, display_coverage_audits: [{
  insight_id: "i", candidate_id: "i", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage",
  decision: { statement_citation_index: 1, statement_citation_ref: "binding", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash("A new model release is announced"), quote_sha256: sourceQuoteHash("A new model release is announced"), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-09T00:00:00Z",
}] };
const item = (id: string, source: string, at: string): ContentItem => ({ id, source_id: source, url: `https://x/${id}`, title: id, author: null, published_at: at, fetched_at: at, language: "en", topic_ids: ["t"], tags: [], body: "model", body_kind: "article", raw_ref: "", content_hash: id, fetch_status: "ok" });

describe("技术线索确定性提取", () => {
  it("仅消费 pass 引用，生成可解释分数和 event canonical key", () => {
    const validation: ValidationResult = { checks: [
      { insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "i", citation_index: 1, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict: "flagged" },
    ], report: { total: 2, pass: 1, blocked: 0, flagged: 1, errored: 0, consistency_failure_rate: 0, flagged_rate: .5, insights_total: 1, insights_includable: 1, releasable: true } };
    const leads = extractLeadCandidates(batch, validation, new Map([["a", item("a", "s1", "2026-07-23T00:00:00Z")], ["b", item("b", "s2", "2026-07-23T01:00:00Z")]]), "2026-07-23T02:00:00Z");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ canonical_key: "event:evt_model", kind: "model", evidence: [{ insight_id: "i", citation_index: 0 }] });
    expect(leads[0].score_detail.reason).toContain("建议关注"); // 只有一条 pass 证据，不把 flagged 算进多源深挖
  });

  it("异常 pass 但非 support 的引用不得成为技术线索证据", () => {
    const validation: ValidationResult = { checks: [
      { insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "uncertain", consistency_reason: "uncertain", verdict: "pass" },
      { insight_id: "i", citation_index: 1, reachability: "pass", reachability_reason: "ok", consistency: "not_support", consistency_reason: "exaggeration", verdict: "pass" },
    ], report: { total: 2, pass: 2, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0.5, flagged_rate: 0.5, insights_total: 1, insights_includable: 0, releasable: false } };
    expect(extractLeadCandidates(batch, validation, new Map([
      ["a", item("a", "s1", "2026-07-23T00:00:00Z")], ["b", item("b", "s2", "2026-07-23T01:00:00Z")],
    ]), "2026-07-23T02:00:00Z")).toEqual([]);
  });

  it("legacy 或未审计批次不能重新派生 reader-visible 技术线索", () => {
    const legacy = { ...batch, display_coverage_state: "legacy" as const, display_projection_version: "legacy" as const, display_coverage_audits: undefined };
    const validation: ValidationResult = { checks: [
      { insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
    ], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
    expect(extractLeadCandidates(legacy, validation, new Map([["a", item("a", "s1", "2026-07-23T00:00:00Z")]]))).toEqual([]);
  });

  it("即使绑定 quote 通过，历史 headline 或自由重要性文本也不能派生技术线索", () => {
    const validation: ValidationResult = { checks: [
      { insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
    ], report: { total: 1, pass: 1, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 1, insights_includable: 1, releasable: true } };
    const withHeadline: AnalysisBatch = { ...batch, insights: [{ ...batch.insights[0]!, headline: "未经原文审计的标题" }] };
    const withFreeImportance: AnalysisBatch = { ...batch, insights: [{ ...batch.insights[0]!, importance_basis: "系统重要性判断：自由改写" }] };
    const items = new Map([["a", item("a", "s1", "2026-07-23T00:00:00Z")]]);
    expect(extractLeadCandidates(withHeadline, validation, items)).toEqual([]);
    expect(extractLeadCandidates(withFreeImportance, validation, items)).toEqual([]);
  });

  it("分类与评分边界稳定", () => {
    expect(classifyTechLead("new SWE-bench evaluation", [])).toBe("benchmark");
    expect(classifyTechLead("新模型发现高危漏洞", [])).toBe("security");
    expect(isTechnicalLead("Anthropic 和 OpenAI 均已秘密递交 IPO 申请")).toBe(false);
    expect(isTechnicalLead("Anthropic 再捐 2000 万美元推动 AI 政策倡导，累计 4000 万")).toBe(false);
    expect(isTechnicalLead("Claude Mythos Preview 发现数千高危漏洞")).toBe(true);
    expect(scoreLead({ observedAt: "2026-07-21T00:00:00Z", now: "2026-07-23T00:00:00Z", sourceCount: 2, importance: 5, tags: ["x"] }).freshness).toBe(0);
  });

  it("同一事件保留不同洞察中的全部 pass 证据，且不混用引用下标", () => {
    const second = { ...batch.insights[0], id: "i2", importance: 3, statement: "Model tool release is announced", statement_citation_index: 1, citations: [{ content_item_id: "b", citation_ref: "binding2", claim: "Model tool release is announced", quote: "Model tool release is announced", locator: { paragraph_index: 0, char_start: 0, char_end: 31 } }] };
    const joined: AnalysisBatch = { ...batch, insights: [batch.insights[0], second], display_coverage_audits: [...batch.display_coverage_audits!, {
      insight_id: "i2", candidate_id: "i2", gate_version: "display-coverage-v6", terminal_reason: "kept", prompt_version: "v6", input_hash: "x", validator_model: "coverage",
      decision: { statement_citation_index: 1, statement_citation_ref: "binding2", display_projection_version: DISPLAY_PROJECTION_VERSION, statement_sha256: sourceQuoteHash(second.statement), quote_sha256: sourceQuoteHash(second.statement), claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }] }, created_at: "2026-09-09T00:00:00Z",
    }] };
    const validation: ValidationResult = { checks: [
      { insight_id: "i", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
      { insight_id: "i2", citation_index: 0, reachability: "pass", reachability_reason: "ok", consistency: "support", consistency_reason: "ok", verdict: "pass" },
    ], report: { total: 2, pass: 2, blocked: 0, flagged: 0, errored: 0, consistency_failure_rate: 0, flagged_rate: 0, insights_total: 2, insights_includable: 2, releasable: true } };
    const [lead] = extractLeadCandidates(joined, validation, new Map([
      ["a", item("a", "s1", "2026-07-23T00:00:00Z")], ["b", item("b", "s2", "2026-07-23T01:00:00Z")],
    ]), "2026-07-23T02:00:00Z");
    expect(lead.evidence).toEqual([{ insight_id: "i", citation_index: 0 }, { insight_id: "i2", citation_index: 0 }]);
  });
});
