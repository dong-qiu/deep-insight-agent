import { describe, expect, it } from "vitest";
import { buildCalibrationRetryInstruction, buildCandidateCalibrationUser, hasValidDistinctDrafts, selectExactCalibratedDraft } from "./a1-consistency-candidate-calibration.js";

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
});
