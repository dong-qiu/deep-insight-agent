import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrototypeCiEvidence, createPrototypeReleaseReceipt, parsePrototypeCiEvidence, writePrototypeReleaseArtifact } from "./prototype-release.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = "a".repeat(40);
function safetyReceipt() {
  return {
    schema_version: "prototype-safety-receipt-v1", policy_version: "prototype-policy-v1", stage: "prototype",
    run_id: "a1-safe", generated_at: "2026-09-23T00:00:00.000Z", source: { commit: sha }, model_config_sha256: "b".repeat(64),
    artifacts: { manifest_sha256: "c".repeat(64), a1_run_sha256: "d".repeat(64) },
    safety: {
      core_complete: true,
      consistency_expected: { support: 1, uncertain: 1, not_support: 3, negative_types: ["exaggeration", "misattribution", "out_of_context"] },
      display_coverage: { unsafe_accept: 0, false_reject: 0, accept_cases: 1, reject_cases: 1 },
      quote_self_contained: { unsafe_accept: 0, false_reject: 0, accept_cases: 1, reject_cases: 1 },
    },
    limitations: ["bounded_forced_smoke_subset"], secret_like_debug: "must-not-leak",
  };
}

describe("prototype release receipts", () => {
  it("binds safe model evidence and green CI evidence to one immutable image tag", () => {
    const ci = createPrototypeCiEvidence({ commit: sha, runUrl: "https://example.test/runs/123", runId: "123", runAttempt: 1 });
    const receipt = createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: ci, generatedAt: "2026-09-23T01:00:00.000Z" });
    expect(receipt).toMatchObject({ commit: sha, image_tag: `sha-${sha}`, ci: ci, safety_eval: { run_id: "a1-safe" } });
    expect(JSON.stringify(receipt)).not.toContain("must-not-leak");
  });

  it("fails closed when CI lacks a required check or evidence points at another commit", () => {
    const failedCi = createPrototypeCiEvidence({ commit: sha, runUrl: "https://example.test/runs/123", runId: "123", runAttempt: 1 }) as unknown as { checks: { build: string } };
    failedCi.checks.build = "fail";
    expect(() => parsePrototypeCiEvidence(failedCi)).toThrow("build 未通过");
    const otherCi = createPrototypeCiEvidence({ commit: "f".repeat(40), runUrl: "https://example.test/runs/123", runId: "123", runAttempt: 1 });
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: otherCi })).toThrow("同一 commit");
  });

  it("writes append-only CI/release artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "prototype-release-"));
    roots.push(root);
    const path = join(root, "ci.json");
    const ci = createPrototypeCiEvidence({ commit: sha, runUrl: "https://example.test/runs/123", runId: "123", runAttempt: 1 });
    writePrototypeReleaseArtifact(path, ci);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(ci);
    expect(() => writePrototypeReleaseArtifact(path, ci)).toThrow();
  });
});
