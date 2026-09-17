import { describe, expect, it } from "vitest";
import { boundedDistinctDrafts, buildCalibrationRetryInstruction, buildCandidateCalibrationUser, CandidateDraftResponseSchema, collectUnambiguousCandidateDrafts, hasValidDistinctDrafts, isRetriableCandidateCalibrationStructuralError, normalizeCandidateDraft, selectExactCalibratedDraft } from "./a1-consistency-candidate-calibration.js";

describe("consistency candidate calibration boundary", () => {
  it("keeps the requested generator intent out of the independent calibration input", () => {
    const prompt = buildCandidateCalibrationUser(
      [{ id: "case-1", source_text: "The source says &lt;keep&gt; this fact." }],
      new Map([["case-1", "The claim preserves <scope>." ]]),
    );
    expect(prompt).toContain('<candidate id="case-1">');
    expect(prompt).toContain("&amp;lt;keep&amp;gt;");
    expect(prompt).not.toContain("requested_intent");
    expect(prompt).not.toContain("out_of_context");
  });

  it("gives retries only the failed candidate's independent observation and prior draft", () => {
    const instruction = buildCalibrationRetryInstruction([{
      id: "case-2", observed_intent: "support", previous_statement: "Prior <draft> & context.",
    }]);
    expect(instruction).toContain('candidate_id="case-2" observed_relation="support"');
    expect(instruction).toContain("Prior &lt;draft&gt; &amp; context.");
    expect(instruction).not.toContain("case-1");
    expect(buildCalibrationRetryInstruction([])).toBe("");
  });

  it("selects only a draft with an exact independently observed intent", () => {
    const observed = new Map([
      ["case-3#draft-1", "support" as const],
      ["case-3#draft-2", "out_of_context" as const],
      ["case-3#draft-3", "uncertain" as const],
    ]);
    expect(selectExactCalibratedDraft("case-3", "uncertain", ["first", "second", "third"], observed)).toBe("third");
    expect(selectExactCalibratedDraft("case-3", "misattribution", ["first", "second", "third"], observed)).toBeUndefined();
  });

  it("accepts three to five different drafts so a valid fourth draft is not rejected by schema shape", () => {
    expect(hasValidDistinctDrafts(["one", "two", "three"])).toBe(true);
    expect(hasValidDistinctDrafts(["one", "two", "three", "four"])).toBe(true);
    expect(hasValidDistinctDrafts(["one", "two", "three", "four", "five"])).toBe(true);
    expect(hasValidDistinctDrafts(["one", "two"])).toBe(false);
    expect(hasValidDistinctDrafts(["one", "two", "three", "three"])).toBe(false);
    expect(hasValidDistinctDrafts(["one", "two", "three", "four", "five", "six"])).toBe(false);
  });

  it("trims a bounded over-return before calibration instead of rejecting an otherwise valid response", () => {
    expect(boundedDistinctDrafts(["one", "two", "two", "three", "four", "five", "six"]))
      .toEqual(["one", "two", "three", "four", "five"]);
  });

  it("normalizes provider-equivalent object draft entries before calibration", () => {
    const parsed = CandidateDraftResponseSchema.parse({
      candidates: [{ id: "case-4", statements: [
        "First complete candidate statement.",
        { statement: "Second complete candidate statement." },
        "Third complete candidate statement.",
      ] }],
    });
    expect(parsed.candidates[0]?.statements.map(normalizeCandidateDraft)).toEqual([
      "First complete candidate statement.",
      "Second complete candidate statement.",
      "Third complete candidate statement.",
    ]);
  });

  it("only retains requested IDs with one valid draft set and returns others for structural retry", () => {
    const result = collectUnambiguousCandidateDrafts(["case-5", "case-6", "case-7"], [
      { id: "case-5", statements: ["First complete statement.", "Second complete statement.", "Third complete statement."] },
      { id: "case-6", statements: ["First complete statement.", "Second complete statement.", "Third complete statement."] },
      { id: "case-6", statements: ["Conflicting complete statement.", "Another complete statement.", "Third alternative complete statement."] },
      { id: "unknown", statements: ["First complete statement.", "Second complete statement.", "Third complete statement."] },
    ]);
    expect([...result.drafts.keys()]).toEqual(["case-5"]);
    expect(result.missing_ids).toEqual(["case-6", "case-7"]);
  });

  it("parses an underspecified response so its ID can enter structural retry, but never accepts it", () => {
    const parsed = CandidateDraftResponseSchema.parse({
      candidates: [{ id: "case-8", statements: ["Only one complete statement."] }],
    });
    const result = collectUnambiguousCandidateDrafts(["case-8"], parsed.candidates);
    expect(result.drafts.size).toBe(0);
    expect(result.missing_ids).toEqual(["case-8"]);
  });

  it("retries only malformed calibration projections, not transport or authorization failures", () => {
    expect(isRetriableCandidateCalibrationStructuralError(new Error("结构化输出 schema 校验失败: invalid enum"))).toBe(true);
    expect(isRetriableCandidateCalibrationStructuralError(new Error("候选 calibration 未返回与输入一一对应的 observed_intent"))).toBe(true);
    expect(isRetriableCandidateCalibrationStructuralError(new Error("LLM stream exceeded wall-clock timeout"))).toBe(false);
    expect(isRetriableCandidateCalibrationStructuralError(new Error("401 unauthorized"))).toBe(false);
    expect(isRetriableCandidateCalibrationStructuralError("结构化输出 schema 校验失败")).toBe(false);
  });
});
