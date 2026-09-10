import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindReviewArtifacts, reviewableInsightTextHash, verifyReviewReceipt, type BlindReviewerSubmission } from "./a1-review-receipt.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function binding() {
  const root = mkdtempSync(join(tmpdir(), "a1-receipt-")); roots.push(root);
  const insights = Array.from({ length: 50 }, (_, index) => ({
    id: `i-${index}`, topic_id: "topic", statement: `Statement ${index}`, importance: 3,
    importance_basis: "basis", statement_citation_index: 1,
    citations: [{ content_item_id: `source-${index}`, quote: `Quote ${index}`, locator: { paragraph_index: 0, char_start: 0, char_end: 7 } }],
  }));
  const queue = { run_id: "run-1", generated_at: "2026-09-10T00:00:00Z", insights };
  const queuePath = join(root, "review-queue.json"); writeFileSync(queuePath, `${JSON.stringify(queue)}\n`);
  const idsHash = sha(insights.map((item) => item.id).sort().join("\n"));
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({ run_id: "run-1", config: { dataset_lock_sha256: "lock" }, insights: { count: insights.length, ids_sha256: idsHash }, artifacts: { "review-queue.json": sha(readFileSync(queuePath)) } })}\n`);
  return bindReviewArtifacts(manifestPath, queuePath);
}

function reviewer(id: string, b: ReturnType<typeof binding>, overrides: Partial<Record<string, Partial<{ non_obvious: boolean; hallucination: boolean; importance_reasonable: boolean }>>> = {}): BlindReviewerSubmission {
  return {
    reviewer_id: id, reviewer_kind: "human", blind_attestation: true,
    decisions: b.insights.map((insight) => ({
      insight_id: insight.id, insight_text_sha256: insight.text_sha256,
      non_obvious: true, hallucination: insight.id === "i-0", importance_reasonable: true,
      ...overrides[insight.id],
    })),
  };
}

describe("A1 review receipt", () => {
  it("binds two complete blind submissions and returns only eligible_for_signoff", () => {
    const b = binding();
    const receipt = verifyReviewReceipt(b, [reviewer("r1", b), reviewer("r2", b)], []);
    expect(receipt).toMatchObject({ status: "eligible_for_signoff", metrics: { reviewed: 50, hallucinations: 1, hallucination_ratio: 0.02 } });
    expect(receipt.note).toContain("不是总体保证");
  });

  it("rejects missing or repeated marks so a partial CSV cannot claim review", () => {
    const b = binding(); const first = reviewer("r1", b); first.decisions.pop();
    const second = reviewer("r2", b); second.decisions.push(second.decisions[0]!);
    const receipt = verifyReviewReceipt(b, [first, second], []);
    expect(receipt.status).toBe("ineligible");
    expect(receipt.issues.join(" ")).toMatch(/缺少 i-49|重复评审 i-0/);
  });

  it("requires a third-person adjudication for every blind-review disagreement", () => {
    const b = binding();
    const first = reviewer("r1", b); const second = reviewer("r2", b, { "i-1": { hallucination: true } });
    expect(verifyReviewReceipt(b, [first, second], []).issues.join(" ")).toContain("分歧项缺少 adjudication：i-1");
    const receipt = verifyReviewReceipt(b, [first, second], [{ insight_id: "i-1", adjudicator_id: "r3", adjudicator_kind: "human", decision: { non_obvious: true, hallucination: false, importance_reasonable: true } }]);
    expect(receipt.status).toBe("eligible_for_signoff");
  });

  it("rejects AI prelabels as either a blind reviewer or an adjudicator", () => {
    const b = binding();
    const aiReviewer = reviewer("ai-1", b); aiReviewer.reviewer_kind = "ai";
    expect(verifyReviewReceipt(b, [aiReviewer, reviewer("r2", b)], []).issues.join(" ")).toContain("AI 预标注不得作为盲评签署证据");

    const first = reviewer("r1", b);
    const second = reviewer("r2", b, { "i-1": { hallucination: true } });
    const receipt = verifyReviewReceipt(b, [first, second], [{
      insight_id: "i-1", adjudicator_id: "ai-3", adjudicator_kind: "ai",
      decision: { non_obvious: true, hallucination: false, importance_reasonable: true },
    }]);
    expect(receipt.status).toBe("ineligible");
    expect(receipt.issues.join(" ")).toContain("AI 预标注不得作为裁决签署证据");
  });

  it("hashes the exact reader-visible text and fails closed when queue bytes differ from manifest", () => {
    const b = binding();
    expect(reviewableInsightTextHash({ id: "i", topic_id: "t", statement: "before" })).not.toBe(reviewableInsightTextHash({ id: "i", topic_id: "t", statement: "after" }));
    expect(b.queue_sha256).toHaveLength(64);
    const root = mkdtempSync(join(tmpdir(), "a1-receipt-tamper-")); roots.push(root);
    const queuePath = join(root, "review-queue.json"); writeFileSync(queuePath, "{\"run_id\":\"run\",\"insights\":[]}\n");
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ run_id: "run", config: { dataset_lock_sha256: "lock" }, insights: { count: 0, ids_sha256: sha("") }, artifacts: { "review-queue.json": "0".repeat(64) } }));
    expect(() => bindReviewArtifacts(manifestPath, queuePath)).toThrow("sha256");
  });
});
