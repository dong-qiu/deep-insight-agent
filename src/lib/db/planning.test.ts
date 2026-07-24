import { describe, expect, it } from "vitest";
import { deriveOpportunityCandidates } from "../agents/opportunity-planning.js";
import { openDb } from "./index.js";
import { listOpportunityLeads, listTechnologyOpportunities, listTopicDirections, seedDefaultDirections, setTechnologyOpportunityStatus, upsertTechnologyOpportunities } from "./planning.js";
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
});
