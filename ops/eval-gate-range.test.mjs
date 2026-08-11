import { describe, expect, it } from "vitest";
import { associatedMergedPullRequest, resolveEvalGateRange } from "./eval-gate-range.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const AFTER = "c".repeat(40);

const mergedPull = {
  number: 226,
  state: "closed",
  merged_at: "2026-08-11T05:59:07Z",
  merge_commit_sha: AFTER,
  base: { sha: BASE },
  head: { sha: HEAD },
};

describe("Eval-Gate CI range", () => {
  it("uses the checked PR range for pull_request events", () => {
    expect(resolveEvalGateRange({
      event: "pull_request",
      prBase: BASE,
      prHead: HEAD,
      prNumber: 226,
    })).toEqual({ baseSha: BASE, headSha: HEAD, pullNumber: 226, source: "pull_request" });
  });

  it("uses the original reviewed PR range after a squash merge", () => {
    expect(resolveEvalGateRange({
      event: "push",
      pushBefore: BASE,
      pushAfter: AFTER,
      pulls: [mergedPull],
    })).toEqual({ baseSha: BASE, headSha: HEAD, pullNumber: 226, source: "merged_pull_request" });
  });

  it("keeps before..after enforcement for a direct push or an unrelated PR", () => {
    expect(associatedMergedPullRequest([{ ...mergedPull, merge_commit_sha: HEAD }], AFTER)).toBeNull();
    expect(resolveEvalGateRange({
      event: "push",
      pushBefore: BASE,
      pushAfter: AFTER,
      pulls: [{ ...mergedPull, merge_commit_sha: HEAD }],
    })).toEqual({ baseSha: BASE, headSha: AFTER, pullNumber: null, source: "direct_push" });
  });
});
