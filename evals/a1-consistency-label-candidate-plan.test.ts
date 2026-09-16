import { describe, expect, it } from "vitest";
import { calibrationMatchesIntent, escapeCandidatePromptData, LABEL_CANDIDATE_DEFAULT_BATCH_SIZE, LABEL_CANDIDATE_MAX_DRAFTS_PER_ATTEMPT, LABEL_CANDIDATE_MIN_DRAFTS_PER_ATTEMPT, LABEL_CANDIDATE_SOURCE_CHARS, LABEL_CANDIDATE_TARGET_NEGATIVE_COUNT, labelCandidateBatchSize, labelSourceWindow, plannedCandidateIntent, selectConsistencyCandidateItems } from "./a1-consistency-label-candidate-plan.js";

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

  it("keeps the ordinary 20-item generator batch by default, but bounds relay recovery batches", () => {
    expect(LABEL_CANDIDATE_MIN_DRAFTS_PER_ATTEMPT).toBe(3);
    expect(LABEL_CANDIDATE_MAX_DRAFTS_PER_ATTEMPT).toBe(5);
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
});
