import { describe, expect, it } from "vitest";
import { consistencyPairHash, type ConsistencyLabel } from "./a1-consistency-label-receipt.js";
import {
  AI_ASSISTED_ADJUDICATION_VERSION,
  AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION,
  AI_ASSISTED_REVIEW_VERSION,
  bindAiAssistedChatAdjudication,
  compareAiAssistedReviews,
  finalizeAiAssistedChatReviews,
  finalizeAiAssistedReviews,
  pairPopulationSha,
  type AiAssistedReviewerSubmission,
} from "./a1-consistency-ai-assisted.js";

const worklist = ["a", "b", "c"].map((id) => {
  const pair = { id, statement: `Statement ${id}`, source_text: `Source ${id}` };
  return { ...pair, pair_sha256: consistencyPairHash(pair) };
});
const worklistSha = "w".repeat(64);
function reviewer(id: string, role: "validator" | "coverage", model: string, labels: ConsistencyLabel[]): AiAssistedReviewerSubmission {
  return {
    schema_version: AI_ASSISTED_REVIEW_VERSION, reviewer_id: id, reviewer_kind: "ai", role, model, thinking: role === "validator",
    structured_thinking_transport_version: "forced-tool-enabled-v1", response_budget_version: "output-3072-v1", max_tokens: 3072,
    prompt_version: "p1", prompt_sha256: "p".repeat(64),
    worklist_sha256: worklistSha, pair_population_sha256: pairPopulationSha(worklist), usage: { calls: 1, tokens: 1, amount_usd: 0.1 },
    decisions: worklist.map((row, index) => ({ case_id: row.id, pair_sha256: row.pair_sha256, expected_consistency: labels[index]!, ...(labels[index] === "not_support" ? { negative_type: "exaggeration" as const } : {}) })),
  };
}

describe("A1 prototype AI-assisted consistency labels", () => {
  it("produces a no-label human dispute worklist and never makes it lock eligible", () => {
    const first = reviewer("ai-validator", "validator", "model-a", ["support", "not_support", "uncertain"]);
    const second = reviewer("ai-coverage", "coverage", "model-b", ["support", "uncertain", "uncertain"]);
    const compared = compareAiAssistedReviews(worklist, worklistSha, first, second);
    expect(compared.receipt).toMatchObject({ status: "prototype_ai_assisted", lock_eligible: false, disagreement: { count: 1 } });
    expect(compared.disputes).toEqual([worklist[1]]);
    expect(Object.keys(compared.disputes[0]!).sort()).toEqual(["id", "pair_sha256", "source_text", "statement"]);
  });

  it("rejects two calls to the same model as independent review", () => {
    const compared = compareAiAssistedReviews(
      worklist, worklistSha,
      reviewer("ai-one", "validator", "same-model", ["support", "support", "support"]),
      reviewer("ai-two", "coverage", "same-model", ["support", "support", "support"]),
    );
    expect(compared.receipt.status).toBe("ineligible");
    expect(compared.receipt.issues.join(" ")).toContain("不同模型");
  });

  it("rejects a reviewer submission that omits its response-budget provenance", () => {
    const missingBudget = reviewer("ai-validator", "validator", "model-a", ["support", "support", "support"]);
    delete (missingBudget as { response_budget_version?: string }).response_budget_version;
    delete (missingBudget as { max_tokens?: number }).max_tokens;
    const compared = compareAiAssistedReviews(
      worklist, worklistSha, missingBudget,
      reviewer("ai-coverage", "coverage", "model-b", ["support", "support", "support"]),
    );
    expect(compared.receipt.status).toBe("ineligible");
    expect(compared.receipt.issues.join(" ")).toContain("响应预算");
  });

  it("requires one blind human decision for every AI disagreement and records a prototype-only final dataset", () => {
    const first = reviewer("ai-validator", "validator", "model-a", ["support", "not_support", "uncertain"]);
    const second = reviewer("ai-coverage", "coverage", "model-b", ["support", "uncertain", "uncertain"]);
    const missing = finalizeAiAssistedReviews(worklist, worklistSha, first, second, null);
    expect(missing.receipt.status).toBe("ineligible");
    expect(missing.receipt.issues.join(" ")).toContain("缺少 human adjudication");

    const completed = finalizeAiAssistedReviews(worklist, worklistSha, first, second, {
      schema_version: AI_ASSISTED_ADJUDICATION_VERSION, adjudicator_id: "human-third", adjudicator_kind: "human", blind_attestation: true,
      dispute_pair_population_sha256: pairPopulationSha([worklist[1]!]),
      decisions: [{ case_id: "b", pair_sha256: worklist[1]!.pair_sha256, expected_consistency: "not_support", negative_type: "out_of_context" }],
    });
    expect(completed.receipt).toMatchObject({ status: "prototype_ai_assisted", lock_eligible: false, final_distribution: { total: 3, not_support: 1 } });
    expect(completed.cases[1]).toMatchObject({ id: "b", expected_consistency: "not_support", negative_type: "out_of_context" });
  });

  it("binds explicitly AI-advised chat decisions separately and prevents them from claiming blind adjudication", () => {
    const first = reviewer("ai-validator", "validator", "model-a", ["support", "not_support", "uncertain"]);
    const second = reviewer("ai-coverage", "coverage", "model-b", ["support", "uncertain", "uncertain"]);
    const dispute = worklist[1]!;
    const chat = bindAiAssistedChatAdjudication([dispute], "d".repeat(64), {
      schema_version: AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION as typeof AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION,
      status: "complete_pending_provenance_safe_finalization",
      adjudication_mode: "human_with_ai_advice",
      blind_attestation: false,
      dispute_worklist_sha256: "d".repeat(64),
      decisions: [{
        case_id: dispute.id, pair_sha256: dispute.pair_sha256, expected_consistency: "not_support", negative_type: "misattribution",
        human_reason: "The displayed advisor recommendation was considered before this decision.",
      }],
    }, "human-chat");
    const completed = finalizeAiAssistedChatReviews(worklist, worklistSha, first, second, chat);
    expect(completed.receipt).toMatchObject({
      status: "prototype_ai_assisted", lock_eligible: false,
      human_adjudication_mode: "human_with_ai_advice", human_adjudication_blind_attestation: false,
    });
    expect(completed.cases[1]).toMatchObject({ id: "b", expected_consistency: "not_support", negative_type: "misattribution" });

    const falselyBlind = finalizeAiAssistedReviews(worklist, worklistSha, first, second, chat as unknown as import("./a1-consistency-ai-assisted.js").AiAssistedHumanAdjudication);
    expect(falselyBlind.receipt.status).toBe("ineligible");
    expect(falselyBlind.receipt.issues.join(" ")).toContain("blind-attested");
  });

  it("rejects incomplete or falsely blind chat progress before an adjudication artifact is written", () => {
    const dispute = worklist[1]!;
    const progress = {
      schema_version: AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION as typeof AI_ASSISTED_CHAT_ADJUDICATION_PROGRESS_VERSION,
      status: "complete_pending_provenance_safe_finalization" as const,
      adjudication_mode: "human_with_ai_advice" as const,
      blind_attestation: false as const,
      dispute_worklist_sha256: "d".repeat(64),
      decisions: [{ case_id: dispute.id, pair_sha256: dispute.pair_sha256, expected_consistency: "support" as const, human_reason: "" }],
    };
    expect(() => bindAiAssistedChatAdjudication([dispute], "d".repeat(64), progress, "human-chat")).toThrow(/human_reason/);
    expect(() => bindAiAssistedChatAdjudication([dispute], "d".repeat(64), { ...progress, blind_attestation: true } as unknown as typeof progress, "human-chat")).toThrow(/blind_attestation=false/);
  });
});
