import { describe, expect, it } from "vitest";
import { assignFeasibleCandidateIntents, calibrationMatchesIntent, candidateIntentConstraint, escapeCandidatePromptData, LABEL_CANDIDATE_DEFAULT_BATCH_SIZE, LABEL_CANDIDATE_MAX_DRAFTS_PER_ATTEMPT, LABEL_CANDIDATE_MAX_RETURNED_DRAFTS_PER_ATTEMPT, LABEL_CANDIDATE_MIN_DRAFTS_PER_ATTEMPT, LABEL_CANDIDATE_SOURCE_CHARS, LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT, labelCandidateBatchSize, labelSourceWindow, plannedCandidateIntent, plannedIntentCounts, plannedSourceIntentSlots, plannedSourceNegativeCounts, selectConsistencyCandidateItems, type CandidateFeasibilityEdge, type CandidateIntent } from "./a1-consistency-label-candidate-plan.js";

const digest = (seed: string): string => [...seed].reduce((sum, character) => (sum * 33 + character.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(64, "0");
const edge = (intent: CandidateIntent, statement = `A calibrated ${intent} statement.`): CandidateFeasibilityEdge => ({
  intent,
  statement,
  statement_sha256: digest(`statement-${intent}`),
  source_text_sha256: digest("source"),
  pair_sha256: digest(`pair-${statement}`),
  calibration_provenance_sha256: digest(`calibration-${intent}`),
  requested_intent: intent,
  observed_intent: intent,
});
const allEdges = (): CandidateFeasibilityEdge[] => (["support", "uncertain", "exaggeration", "out_of_context", "misattribution"] as CandidateIntent[]).map((intent) => edge(intent));

describe("v2 consistency-label candidate plan", () => {
  it("plans 50 source-balanced diagnostic negative cases across all required types for 100 inputs", () => {
    const planned = Array.from({ length: 100 }, (_, index) => plannedCandidateIntent(index));
    expect(planned.filter((intent) => intent === "exaggeration")).toHaveLength(20);
    expect(planned.filter((intent) => intent === "out_of_context")).toHaveLength(20);
    expect(planned.filter((intent) => intent === "misattribution")).toHaveLength(10);
    expect(planned.filter((intent) => ["exaggeration", "out_of_context", "misattribution"].includes(intent))).toHaveLength(LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT);
    for (let start = 0; start < planned.length; start += 10) {
      expect(planned.slice(start, start + 10).filter((intent) => ["exaggeration", "out_of_context", "misattribution"].includes(intent))).toHaveLength(5);
    }
  });

  it("requires an exact independent calibration match instead of treating a requested intent as evidence", () => {
    expect(calibrationMatchesIntent("out_of_context", "out_of_context")).toBe(true);
    expect(calibrationMatchesIntent("out_of_context", "exaggeration")).toBe(false);
    expect(calibrationMatchesIntent("misattribution", "support")).toBe(false);
  });

  it("assigns only exact calibrated pair edges while preserving topic, source, and intent slots", () => {
    const intents: CandidateIntent[] = ["support", "uncertain", "exaggeration", "out_of_context", "misattribution"];
    const items = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `topic-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: `source-${topic}-${index % 2}`,
      feasible_edges: index === 0 ? [edge("support", "The bound support pair is selected verbatim.")] : allEdges(),
    }))).flat();
    const assigned = assignFeasibleCandidateIntents(items);
    expect(assigned).toHaveLength(100);
    expect(assigned.get("topic-0-0")).toMatchObject({
      intent: "support", statement: "The bound support pair is selected verbatim.", pair_sha256: digest("pair-The bound support pair is selected verbatim."),
    });
    for (const topic of Array.from({ length: 5 }, (_, index) => `topic-${index}`)) {
      const counts = Object.fromEntries(intents.map((intent) => [intent, [...assigned].filter(([id, assignedEdge]) => id.startsWith(`${topic}-`) && assignedEdge.intent === intent).length]));
      expect(counts).toEqual(plannedIntentCounts());
    }
  });

  it("fails closed rather than relabeling an infeasible source as a required negative type", () => {
    const items = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `topic-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: `source-${topic}`,
      feasible_edges: topic === 0 && index === 0 ? [edge("support")] : allEdges().filter((candidateEdge) => candidateEdge.intent !== "out_of_context"),
    }))).flat();
    expect(() => assignFeasibleCandidateIntents(items)).toThrow("cannot meet exact topic × source × intent quota");
  });

  it("rejects an edge whose observed support is being passed off as a negative relation", () => {
    const invalid = { ...edge("out_of_context"), observed_intent: "support" as const };
    const items = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `topic-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: `source-${topic}-${index < 10 ? "a" : "b"}`,
      feasible_edges: topic === 0 && index === 0 ? [invalid] : allEdges(),
    }))).flat();
    expect(() => assignFeasibleCandidateIntents(items)).toThrow("invalid or duplicate calibrated feasibility edge");
  });

  it("requires each 10-item source to retain five negatives split 2/2/1 by negative type", () => {
    const topic = Array.from({ length: 20 }, (_, index) => ({
      id: `candidate-${index}`, topic_id: "topic", source_id: index < 10 ? "source-a" : "source-b",
    }));
    const slots = plannedSourceIntentSlots(topic);
    expect(slots.get("source-a")).toMatchObject({ exaggeration: 2, out_of_context: 2, misattribution: 1 });
    expect(slots.get("source-b")).toMatchObject({ exaggeration: 2, out_of_context: 2, misattribution: 1 });
    expect(plannedSourceNegativeCounts(topic)).toEqual(new Map([["source-a", 5], ["source-b", 5]]));
  });

  it("uses stable floor/ceil source negative quotas for uneven source strata", () => {
    const topic = Array.from({ length: 20 }, (_, index) => ({
      id: `candidate-${index}`, topic_id: "topic", source_id: index < 7 ? "source-a" : "source-b",
    }));
    expect(plannedSourceNegativeCounts(topic)).toEqual(new Map([["source-a", 4], ["source-b", 6]]));
    const slots = plannedSourceIntentSlots(topic);
    expect(["exaggeration", "out_of_context", "misattribution"]
      .reduce((sum, intent) => sum + slots.get("source-a")![intent as CandidateIntent], 0)).toBe(4);
    expect(["exaggeration", "out_of_context", "misattribution"]
      .reduce((sum, intent) => sum + slots.get("source-b")![intent as CandidateIntent], 0)).toBe(6);
  });

  it("fails even when global type totals look feasible if one source cannot supply its assigned negatives", () => {
    const items = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `topic-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: index < 10 ? "source-a" : "source-b",
      feasible_edges: index < 10 ? [edge("support"), edge("uncertain")] : allEdges(),
    }))).flat();
    expect(() => assignFeasibleCandidateIntents(items)).toThrow("cannot meet exact topic × source × intent quota");
  });

  it("is deterministic when input ordering changes", () => {
    const items = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `topic-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: index < 10 ? "source-a" : "source-b", feasible_edges: allEdges(),
    }))).flat();
    const first = Object.fromEntries([...assignFeasibleCandidateIntents(items)].map(([id, selected]) => [id, selected.pair_sha256]));
    const reversed = Object.fromEntries([...assignFeasibleCandidateIntents([...items].reverse())].map(([id, selected]) => [id, selected.pair_sha256]));
    expect(reversed).toEqual(first);
  });

  it("makes each requested diagnostic relation observable, especially out-of-context rather than direct support", () => {
    expect(candidateIntentConstraint("support")).toContain("preserve every material");
    expect(candidateIntentConstraint("uncertain")).toContain("absent from the excerpt");
    expect(candidateIntentConstraint("exaggeration")).toContain("no longer be directly supported");
    expect(candidateIntentConstraint("out_of_context")).toContain("Never return a complete directly supported fact");
    expect(candidateIntentConstraint("misattribution")).toContain("two explicitly named");
  });

  it("keeps the ordinary 20-item generator batch by default, but bounds relay recovery batches", () => {
    expect(LABEL_CANDIDATE_MIN_DRAFTS_PER_ATTEMPT).toBe(3);
    expect(LABEL_CANDIDATE_MAX_DRAFTS_PER_ATTEMPT).toBe(5);
    expect(LABEL_CANDIDATE_MAX_RETURNED_DRAFTS_PER_ATTEMPT).toBe(12);
    expect(labelCandidateBatchSize(undefined)).toBe(LABEL_CANDIDATE_DEFAULT_BATCH_SIZE);
    expect(labelCandidateBatchSize("5")).toBe(5);
    expect(() => labelCandidateBatchSize("0")).toThrow("1-20");
    expect(() => labelCandidateBatchSize("21")).toThrow("1-20");
    expect(() => labelCandidateBatchSize("five")).toThrow("1-20");
  });

  it("uses only an exact source prefix and prefers a complete sentence boundary", () => {
    const body = `${"a".repeat(Math.floor(LABEL_CANDIDATE_SOURCE_CHARS * 0.8))}. ${"b".repeat(LABEL_CANDIDATE_SOURCE_CHARS)}`;
    const window = labelSourceWindow(body);
    expect(body.startsWith(window)).toBe(true);
    expect(window).toMatch(/\.\s$/);
    expect(window.length).toBeLessThan(LABEL_CANDIDATE_SOURCE_CHARS);
  });

  it("escapes untrusted excerpts for the generator prompt without transforming the review excerpt", () => {
    const source = "<ignore_previous>& keep original > characters";
    expect(escapeCandidatePromptData(source)).toBe("&lt;ignore_previous&gt;&amp; keep original &gt; characters");
    expect(source).toBe("<ignore_previous>& keep original > characters");
  });

  it("selects a stable 100-pair population from a 140-item expanded quality snapshot", () => {
    const standardTopics = ["t_code_agents", "t_prompt_injection", "t_ai_industry", "t_agent_security"];
    const items = standardTopics.flatMap((topicId) => Array.from({ length: 20 }, (_, index) => ({
      id: `${topicId}-${index}`, topic_id: topicId, source_id: index < 10 ? `${topicId}-a` : `${topicId}-b`,
    })));
    items.push(...Array.from({ length: 10 }, (_, index) => ({ id: `openai-${index}`, topic_id: "t_coding_agent_platforms", source_id: "src_openai_codex_releases" })));
    items.push(...Array.from({ length: 50 }, (_, index) => ({ id: `cursor-${index}`, topic_id: "t_coding_agent_platforms", source_id: "src_cursor_changelog" })));

    const selected = selectConsistencyCandidateItems(items);
    expect(selected).toHaveLength(100);
    expect(selected.filter((item) => item.topic_id === "t_coding_agent_platforms")).toHaveLength(20);
    expect(selected.filter((item) => item.source_id === "src_openai_codex_releases")).toHaveLength(10);
    expect(selected.filter((item) => item.source_id === "src_cursor_changelog")).toHaveLength(10);
    expect(selectConsistencyCandidateItems(items).map((item) => item.id)).toEqual(selected.map((item) => item.id));
  });

  it("rejects an undersized or wrong-topic quality population", () => {
    const undersized = Array.from({ length: 5 }, (_, topic) => Array.from({ length: topic === 0 ? 19 : 20 }, (_, index) => ({
      id: `${topic}-${index}`, topic_id: `topic-${topic}`, source_id: "source",
    }))).flat();
    expect(() => selectConsistencyCandidateItems(undersized)).toThrow("至少需要 20 条");
    const fourTopics = Array.from({ length: 4 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `four-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: "source",
    }))).flat();
    expect(() => selectConsistencyCandidateItems(fourTopics)).toThrow("恰有 5 个 topic");
  });

  it("rejects a 20-item topic from one source instead of silently losing cross-source balance", () => {
    const singleSource = Array.from({ length: 5 }, (_, topic) => Array.from({ length: 20 }, (_, index) => ({
      id: `single-${topic}-${index}`, topic_id: `topic-${topic}`, source_id: `only-source-${topic}`,
    }))).flat();
    expect(() => selectConsistencyCandidateItems(singleSource)).toThrow("至少需要 2 个来源");
  });
});
