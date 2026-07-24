import { describe, expect, it } from "vitest";
import type { TechLead, TopicDirection } from "../types.js";
import { deriveOpportunityCandidates, scoreOpportunity } from "./opportunity-planning.js";

const direction = (overrides: Partial<TopicDirection> = {}): TopicDirection => ({
  id: "d", topic_id: "t", name: "可靠性评测", objective: "可靠", problem_statement: "难评估",
  in_scope: [], out_of_scope: [], key_questions: [], constraints: [], success_signals: [],
  match_terms: ["swe-bench", "benchmark"], adjacent_terms: ["agent"], challenge_terms: ["regression"],
  horizon: "now", status: "active", version: 1, created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z", ...overrides,
});
const lead = (overrides: Partial<TechLead> = {}): TechLead => ({
  id: "l", topic_id: "t", canonical_key: "event:x", kind: "benchmark", title: "SWE-bench benchmark", summary: "Agent evaluation result",
  status: "recommended", score: 80, score_detail: { freshness: 30, evidence: 25, importance: 16, relevance: 20, total: 91, reason: "x" },
  first_seen_at: "2026-07-23T00:00:00Z", last_seen_at: "2026-07-23T00:00:00Z", latest_evidence_at: "2026-07-23T00:00:00Z", ...overrides,
});

describe("技术机会确定性投影", () => {
  it("命中显式方向词时创建核心候选，且假设不伪装为事实", () => {
    const [candidate] = deriveOpportunityCandidates([lead()], [direction()], "2026-07-24T00:00:00Z");
    expect(candidate).toMatchObject({ direction_id: "d", lane: "core", planning_effect: "reinforce", lead_id: "l" });
    expect(candidate.hypothesis).toContain("待验证假设");
    expect(candidate.proposed_validation).toContain("任务集");
  });

  it("挑战词优先于核心词，并保留为方向反证", () => {
    const [candidate] = deriveOpportunityCandidates([lead({ title: "SWE-bench regression" })], [direction()], "2026-07-24T00:00:00Z");
    expect(candidate).toMatchObject({ lane: "challenge", planning_effect: "challenge" });
  });

  it("未命中方向但高价值的线索只进入 horizon，不自动创建方向", () => {
    const [candidate] = deriveOpportunityCandidates([lead({ title: "Robotics tool", summary: "hardware method" })], [direction()], "2026-07-24T00:00:00Z");
    expect(candidate).toMatchObject({ lane: "horizon", direction_id: null, planning_effect: "new_direction" });
  });

  it("时机只占 10 分，不能压过证据与方向匹配", () => {
    const fresh = scoreOpportunity(lead(), "core", "2026-07-23T00:00:00Z");
    const old = scoreOpportunity(lead({ latest_evidence_at: "2026-06-01T00:00:00Z" }), "core", "2026-07-23T00:00:00Z");
    expect(fresh.timing - old.timing).toBeLessThanOrEqual(10);
    expect(fresh.alignment + fresh.evidence + fresh.leverage).toBeGreaterThan(fresh.timing);
  });
});
