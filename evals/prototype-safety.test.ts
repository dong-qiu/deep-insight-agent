import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certifyPrototypeSafetyRun, parsePrototypeSafetyReceipt, writePrototypeSafetyReceipt } from "./prototype-safety.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function evidence() {
  return {
    manifest: {
      status: "completed", auto_gate: "smoke", source: { commit: "a".repeat(40) },
      // This deliberately must not be copied into the receipt.
      secret_like_debug: "do-not-persist",
    },
    a1_run: {
      run_id: "a1-20260923000000-deadbeef", config: { analyzer_model: "analyzer", validator_model: "validator", coverage_model: "coverage" },
      dataset: { smoke: true, smoke_forced: true }, completion: { core_complete: true },
      judge_cases: [
        { expected: "support", error: null, source_text: "source body must stay out" },
        { expected: "uncertain", error: null },
        { expected: "not_support", negative_type: "exaggeration", error: null },
        { expected: "not_support", negative_type: "out_of_context", error: null },
        { expected: "not_support", negative_type: "misattribution", error: null },
      ],
      display_coverage: {
        unsafe_accept: { count: 0 }, false_reject: { count: 1 },
        results: [
          { expected: "reject", actual: "reject", error: null, projection_matches_expected: true },
          { expected: "accept", actual: "accept", error: null, projection_matches_expected: true },
          { expected: "accept", actual: "reject", error: null, projection_matches_expected: true },
        ],
      },
      quote_self_contained_coverage: {
        unsafe_accept: { count: 0 }, false_reject: { count: 0 },
        results: [
          { expected: "reject", actual: "reject", error: null },
          { expected: "accept", actual: "accept", error: null },
        ],
      },
    },
    manifest_sha256: "b".repeat(64), a1_run_sha256: "c".repeat(64), generated_at: "2026-09-23T00:00:00.000Z",
  };
}

describe("prototype safety receipt", () => {
  it("accepts a complete safe forced-smoke run and emits aggregate-only evidence", () => {
    const receipt = certifyPrototypeSafetyRun(evidence());
    expect(receipt).toMatchObject({
      stage: "prototype", source: { commit: "a".repeat(40) },
      safety: {
        consistency_expected: { support: 1, uncertain: 1, not_support: 3, negative_types: ["exaggeration", "misattribution", "out_of_context"] },
        display_coverage: { unsafe_accept: 0, false_reject: 1, accept_cases: 2, reject_cases: 1 },
        quote_self_contained: { unsafe_accept: 0, false_reject: 0, accept_cases: 1, reject_cases: 1 },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("source body must stay out");
    expect(JSON.stringify(receipt)).not.toContain("do-not-persist");
  });

  it("fails closed for an unsafe display acceptance or missing positive coverage", () => {
    const unsafe = evidence();
    (unsafe.a1_run.display_coverage as { unsafe_accept: { count: number }; results: Array<{ expected: string; actual: string }> }).unsafe_accept.count = 1;
    (unsafe.a1_run.display_coverage as { results: Array<{ expected: string; actual: string }> }).results[0].actual = "accept";
    expect(() => certifyPrototypeSafetyRun(unsafe)).toThrow("unsafe_accept=1");

    const oneSided = evidence();
    (oneSided.a1_run.quote_self_contained_coverage as { results: unknown[] }).results = [{ expected: "reject", actual: "reject", error: null }];
    expect(() => certifyPrototypeSafetyRun(oneSided)).toThrow("必须同时含应接受与应拒绝样本");
  });

  it("rejects incomplete or smuggled aggregate receipts before a release can reference them", () => {
    const receipt = certifyPrototypeSafetyRun(evidence());
    expect(parsePrototypeSafetyReceipt(receipt)).toEqual(receipt);

    const missingCoverage = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete (missingCoverage.safety as Record<string, unknown>).quote_self_contained;
    expect(() => parsePrototypeSafetyReceipt(missingCoverage)).toThrow("字段不匹配");

    const missingNegativeType = structuredClone(receipt) as unknown as Record<string, unknown>;
    ((missingNegativeType.safety as Record<string, unknown>).consistency_expected as Record<string, unknown>).negative_types = ["exaggeration", "out_of_context"];
    expect(() => parsePrototypeSafetyReceipt(missingNegativeType)).toThrow("negative_type");

    const urlRunId = structuredClone(receipt) as unknown as Record<string, unknown>;
    urlRunId.run_id = "https://example.test/run";
    expect(() => parsePrototypeSafetyReceipt(urlRunId)).toThrow("run_id 无效");

    const smuggledField = { ...receipt, secret_like_debug: "must-not-pass" };
    expect(() => parsePrototypeSafetyReceipt(smuggledField)).toThrow("字段不匹配");
  });

  it("writes once and refuses to overwrite a run-bound receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "prototype-safety-"));
    roots.push(root);
    const path = join(root, "prototype-safety.json");
    const receipt = certifyPrototypeSafetyRun(evidence());
    writePrototypeSafetyReceipt(path, receipt);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(receipt);
    expect(() => writePrototypeSafetyReceipt(path, receipt)).toThrow();
  });
});
