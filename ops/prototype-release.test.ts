import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrototypeCiEvidence, createPrototypeDockerEvidence, createPrototypeReleaseReceipt, parsePrototypeCiEvidence, parsePrototypeDockerEvidence, writePrototypeReleaseArtifact } from "./prototype-release.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = "a".repeat(40);
function safetyReceipt() {
  return {
    schema_version: "prototype-safety-receipt-v1", policy_version: "prototype-policy-v1", stage: "prototype",
    run_id: "a1-20260923000000-deadbeef", generated_at: "2026-09-23T00:00:00.000Z", source: { commit: sha }, model_config_sha256: "b".repeat(64),
    artifacts: { manifest_sha256: "c".repeat(64), a1_run_sha256: "d".repeat(64) },
    safety: {
      core_complete: true,
      consistency_expected: { support: 1, uncertain: 1, not_support: 3, negative_types: ["exaggeration", "misattribution", "out_of_context"] },
      display_coverage: { unsafe_accept: 0, false_reject: 0, accept_cases: 1, reject_cases: 1 },
      quote_self_contained: { unsafe_accept: 0, false_reject: 0, accept_cases: 1, reject_cases: 1 },
    },
    limitations: ["bounded_forced_smoke_subset", "no_formal_baseline_comparison", "no_dcp_or_source_terms_attestation"],
  };
}

describe("prototype release receipts", () => {
  it("binds safe model evidence and green CI evidence to one immutable image tag", () => {
    const ci = createPrototypeCiEvidence({ commit: sha, runId: "123", runAttempt: 1 });
    const docker = createPrototypeDockerEvidence({ commit: sha, runId: "123", runAttempt: 1 });
    // The verify-job artifact must not claim the downstream Docker job has run.
    expect(ci.checks).toEqual({ lint: "pass", test: "pass", typecheck: "pass", build: "pass" });
    expect(ci.tested_commit).toBe(sha);
    const receipt = createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: ci, dockerEvidence: docker, generatedAt: "2026-09-23T01:00:00.000Z" });
    expect(receipt).toMatchObject({ commit: sha, image_tag: `sha-${sha}`, ci: { verify: ci, docker }, safety_eval: { run_id: "a1-20260923000000-deadbeef" } });
    expect(JSON.stringify(receipt)).not.toContain("http");
  });

  it("fails closed when CI/Docker evidence lacks a required check or mismatches the release run", () => {
    const failedCi = createPrototypeCiEvidence({ commit: sha, runId: "123", runAttempt: 1 }) as unknown as { checks: { build: string } };
    failedCi.checks.build = "fail";
    expect(() => parsePrototypeCiEvidence(failedCi)).toThrow("build 未通过");
    const failedDocker = createPrototypeDockerEvidence({ commit: sha, runId: "123", runAttempt: 1 }) as unknown as { checks: { docker: string } };
    failedDocker.checks.docker = "fail";
    expect(() => parsePrototypeDockerEvidence(failedDocker)).toThrow("docker 未通过");
    const otherCi = createPrototypeCiEvidence({ commit: "f".repeat(40), runId: "123", runAttempt: 1 });
    const docker = createPrototypeDockerEvidence({ commit: sha, runId: "123", runAttempt: 1 });
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: otherCi, dockerEvidence: docker })).toThrow("同一 commit");
    const otherRunDocker = createPrototypeDockerEvidence({ commit: sha, runId: "456", runAttempt: 1 });
    const ci = createPrototypeCiEvidence({ commit: sha, runId: "123", runAttempt: 1 });
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: ci, dockerEvidence: otherRunDocker })).toThrow("同一测试运行");
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: ci, dockerEvidence: {} })).toThrow("Docker evidence");

    const incompleteSafety = safetyReceipt() as unknown as { safety: Record<string, unknown> };
    delete incompleteSafety.safety.quote_self_contained;
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: incompleteSafety, ciEvidence: ci, dockerEvidence: docker })).toThrow("字段不匹配");

    const urlRunCi = { ...ci, run: { ...ci.run, id: "https://example.test/123" } };
    expect(() => createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: urlRunCi, dockerEvidence: docker })).toThrow("numeric run id");
  });

  it("retains a separately tested PR merge commit without losing the release subject", () => {
    const ci = createPrototypeCiEvidence({
      commit: sha,
      testedCommit: "b".repeat(40),
      runId: "123",
      runAttempt: 1,
    });
    const docker = createPrototypeDockerEvidence({ commit: sha, testedCommit: "b".repeat(40), runId: "123", runAttempt: 1 });
    const receipt = createPrototypeReleaseReceipt({ commit: sha, safetyReceipt: safetyReceipt(), ciEvidence: ci, dockerEvidence: docker });
    expect(receipt.ci).toMatchObject({ verify: { commit: sha, tested_commit: "b".repeat(40) }, docker: { commit: sha, tested_commit: "b".repeat(40) } });
  });

  it("writes append-only CI/release artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "prototype-release-"));
    roots.push(root);
    const path = join(root, "ci.json");
    const ci = createPrototypeCiEvidence({ commit: sha, runId: "123", runAttempt: 1 });
    writePrototypeReleaseArtifact(path, ci);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(ci);
    expect(() => writePrototypeReleaseArtifact(path, ci)).toThrow();
  });
});
