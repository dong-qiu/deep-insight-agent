import { describe, expect, it } from "vitest";
import {
  verifyConsistencyLabelReceipt,
  type ConsistencyBlindReviewerSubmission,
  type ConsistencyLabelBinding,
} from "./a1-consistency-label-receipt.js";

function binding(): ConsistencyLabelBinding {
  const cases = Array.from({ length: 100 }, (_, index) => {
    const negative = index < 40;
    return {
      id: `case-${index}`,
      pair_sha256: index.toString(16).padStart(64, "0"),
      expected_consistency: negative ? "not_support" as const : "support" as const,
      ...(negative ? { negative_type: ["exaggeration", "out_of_context", "misattribution"][index % 3] as "exaggeration" | "out_of_context" | "misattribution" } : {}),
    };
  });
  return { dataset_sha256: "d".repeat(64), case_ids_sha256: "i".repeat(64), pair_texts_sha256: "p".repeat(64), cases };
}

function reviewer(id: string, b: ConsistencyLabelBinding, changes: Partial<Record<string, "support" | "not_support" | "uncertain">> = {}): ConsistencyBlindReviewerSubmission {
  return {
    reviewer_id: id, reviewer_kind: "human", blind_attestation: true,
    decisions: b.cases.map((entry) => {
      const label = changes[entry.id] ?? entry.expected_consistency;
      return {
        case_id: entry.id, pair_sha256: entry.pair_sha256, expected_consistency: label,
        ...(label === "not_support" ? { negative_type: entry.negative_type ?? "exaggeration" } : {}),
      };
    }),
  };
}

describe("A1 v2 consistency label receipt", () => {
  it("accepts an exact 100-pair, two-human, fully distributed label population", () => {
    const b = binding();
    const receipt = verifyConsistencyLabelReceipt(b, [reviewer("human-a", b), reviewer("human-b", b)], []);
    expect(receipt).toMatchObject({
      status: "eligible_for_lock",
      distribution: { total: 100, not_support: 40, negative_types: { exaggeration: 14, out_of_context: 13, misattribution: 13 } },
    });
  });

  it("rejects a missing third-person decision and never lets the final JSONL override a disagreement", () => {
    const b = binding();
    const second = reviewer("human-b", b, { "case-0": "uncertain" });
    const noAdjudication = verifyConsistencyLabelReceipt(b, [reviewer("human-a", b), second], []);
    expect(noAdjudication.status).toBe("ineligible");
    expect(noAdjudication.issues.join(" ")).toContain("分歧项缺少 adjudication：case-0");

    const wrongFinal = { ...b, cases: b.cases.map((entry) => entry.id === "case-0" ? { ...entry, expected_consistency: "uncertain" as const, negative_type: undefined } : entry) };
    const receipt = verifyConsistencyLabelReceipt(wrongFinal, [reviewer("human-a", b), reviewer("human-b", b)], []);
    expect(receipt.status).toBe("ineligible");
    expect(receipt.issues.join(" ")).toContain("case-0 未绑定两份盲标/裁决的最终标签");
  });

  it("rejects AI labels and an adjudicator who is not a distinct third human", () => {
    const b = binding();
    const ai = reviewer("ai-1", b); ai.reviewer_kind = "ai";
    const receipt = verifyConsistencyLabelReceipt(b, [ai, reviewer("human-b", b)], []);
    expect(receipt.status).toBe("ineligible");
    expect(receipt.issues.join(" ")).toContain("AI 预标注不能作为 v2 标签证据");
    expect(receipt.reviewers[0]).toMatchObject({ reviewer_kind: "ai", blind_attestation: true });

    const second = reviewer("human-b", b, { "case-0": "uncertain" });
    const withAiAdjudicator = verifyConsistencyLabelReceipt(b, [reviewer("human-a", b), second], [{
      case_id: "case-0", adjudicator_id: "human-a", adjudicator_kind: "ai",
      decision: { expected_consistency: "not_support", negative_type: "exaggeration" },
    }]);
    expect(withAiAdjudicator.status).toBe("ineligible");
    expect(withAiAdjudicator.issues.join(" ")).toMatch(/第三人|adjudicator_kind=human/);
  });
});
