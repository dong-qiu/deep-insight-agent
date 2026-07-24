import { describe, expect, it } from "vitest";
import { deriveOpportunityCandidates } from "../agents/opportunity-planning.js";
import { openDb } from "./index.js";
import { listOpportunityLeads, listTechnologyOpportunities, listTopicDirections, previewTopicDirectionMapping, reprojectTopicDirection, seedDefaultDirections, setTechnologyOpportunityStatus, updateTopicDirection, upsertTechnologyOpportunities } from "./planning.js";
import { insertTopic } from "./repos.js";
import { upsertTechLeads } from "./tech-leads.js";
import type { Topic } from "../types.js";

const topic: Topic = { id: "t_code_agents", name: "Code Agent", keywords: ["agent"], language: "en", brief_schedule: "daily", enabled: true };

describe("技术规划持久化", () => {
  it("播种方向、持久化机会与线索关系，并保留人工状态", () => {
    const db = openDb(":memory:");
    insertTopic(db, topic);
    expect(seedDefaultDirections(db)).toBeGreaterThan(0);
    const [lead] = upsertTechLeads(db, [{
      topic_id: topic.id, canonical_key: "event:benchmark", kind: "benchmark", title: "SWE-bench benchmark", summary: "evaluation",
      evidence: [], observed_at: "2026-07-23T00:00:00Z", score: 80,
      score_detail: { freshness: 30, evidence: 25, importance: 16, relevance: 20, total: 91, reason: "x" },
    }], "2026-07-23T00:00:00Z");
    const directions = listTopicDirections(db, { topic: topic.id });
    const candidates = deriveOpportunityCandidates([lead], directions, "2026-07-24T00:00:00Z");
    const [opportunity] = upsertTechnologyOpportunities(db, candidates, new Map([[lead.id, lead]]), "2026-07-24T00:00:00Z");
    expect(listOpportunityLeads(db, opportunity.id)).toMatchObject([{ id: lead.id }]);
    expect(setTechnologyOpportunityStatus(db, opportunity.id, "research_candidate")).toBe(true);
    upsertTechnologyOpportunities(db, candidates, new Map([[lead.id, lead]]), "2026-07-24T01:00:00Z");
    expect(listTechnologyOpportunities(db)[0]).toMatchObject({ id: opportunity.id, status: "research_candidate", lane: "core" });
  });

  it("词表更新递增版本并标记候选待复核；显式重投影不撤销人工研究状态", () => {
    const db = openDb(":memory:");
    insertTopic(db, topic); seedDefaultDirections(db);
    const [lead] = upsertTechLeads(db, [{
      topic_id: topic.id, canonical_key: "event:benchmark", kind: "benchmark", title: "SWE-bench benchmark", summary: "evaluation", evidence: [], observed_at: "2026-07-23T00:00:00Z", score: 80,
      score_detail: { freshness: 30, evidence: 25, importance: 16, relevance: 20, total: 91, reason: "x" },
    }], "2026-07-23T00:00:00Z");
    const direction = listTopicDirections(db, { topic: topic.id }).find((item) => item.id === "dir_code_agent_reliability")!;
    const [candidate] = deriveOpportunityCandidates([lead], [direction], "2026-07-24T00:00:00Z");
    const [opportunity] = upsertTechnologyOpportunities(db, [candidate], new Map([[lead.id, lead]]));
    setTechnologyOpportunityStatus(db, opportunity.id, "research_candidate");
    const draft = { ...direction, match_terms: ["unmatched"], adjacent_terms: ["unmatched"], challenge_terms: ["unmatched"] };
    expect(previewTopicDirectionMapping([lead], direction, draft)).toMatchObject([{ lead_id: lead.id, before: { lane: "core" }, after: null }]);
    const updated = updateTopicDirection(db, draft, direction.version);
    expect(updated).toMatchObject({ kind: "updated", direction: { version: direction.version + 1 } });
    expect(listTechnologyOpportunities(db)[0]).toMatchObject({ status: "research_candidate", mapping_state: "stale" });
    expect(reprojectTopicDirection(db, direction.id)).toMatchObject({ kind: "done", refreshed: 0 });
    expect(listTechnologyOpportunities(db)[0]).toMatchObject({ status: "research_candidate", mapping_state: "stale" });
    expect(updateTopicDirection(db, draft, direction.version)).toMatchObject({ kind: "conflict" });
  });
});
