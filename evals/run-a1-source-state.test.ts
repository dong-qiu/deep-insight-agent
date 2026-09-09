import { describe, expect, it } from "vitest";
import { DIRTY_SOURCE_FINGERPRINT_ALGORITHM, dirtyFingerprintFromSnapshot, dirtyFingerprintFromStatus } from "./a1-source-state.js";

describe("A1 source-state fingerprint", () => {
  it("records a clean checkout as clean rather than hashing an empty porcelain result", () => {
    expect(dirtyFingerprintFromStatus("")).toBeNull();
    expect(dirtyFingerprintFromStatus(" M src/lib/example.ts\n")).toMatch(/^[a-f0-9]{64}$/u);
    expect(dirtyFingerprintFromStatus(null)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when a dirty tracked file's bytes change even if porcelain paths do not", () => {
    const base = {
      status: " M src/lib/example.ts\0",
      staged_diff: "",
      unstaged_diff: "diff --git a/example b/example\n-old\n+new\n",
      untracked: [{ path: "scratch.txt", content: "first" }],
    };
    expect(DIRTY_SOURCE_FINGERPRINT_ALGORITHM).toBe("git-diff-and-untracked-sha256-v2");
    expect(dirtyFingerprintFromSnapshot(base)).not.toBe(dirtyFingerprintFromSnapshot({
      ...base,
      unstaged_diff: "diff --git a/example b/example\n-old\n+changed\n",
    }));
    expect(dirtyFingerprintFromSnapshot(base)).not.toBe(dirtyFingerprintFromSnapshot({
      ...base,
      untracked: [{ path: "scratch.txt", content: "changed" }],
    }));
  });
});
