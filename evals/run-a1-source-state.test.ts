import { describe, expect, it } from "vitest";
import { dirtyFingerprintFromStatus } from "./a1-source-state.js";

describe("A1 source-state fingerprint", () => {
  it("records a clean checkout as clean rather than hashing an empty porcelain result", () => {
    expect(dirtyFingerprintFromStatus("")).toBeNull();
    expect(dirtyFingerprintFromStatus(" M src/lib/example.ts\n")).toMatch(/^[a-f0-9]{64}$/u);
    expect(dirtyFingerprintFromStatus(null)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
