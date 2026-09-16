import { describe, expect, it } from "vitest";
import { buildCalibrationRetryInstruction, buildCandidateCalibrationUser } from "./a1-consistency-candidate-calibration.js";

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

  it("gives retries only the failed candidate's independent observation", () => {
    const instruction = buildCalibrationRetryInstruction([{ id: "case-2", observed_intent: "support" }]);
    expect(instruction).toContain('candidate id="case-2" was observed as "support"');
    expect(instruction).not.toContain("case-1");
    expect(buildCalibrationRetryInstruction([])).toBe("");
  });
});
