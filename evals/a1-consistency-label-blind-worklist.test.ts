import { describe, expect, it } from "vitest";
import { consistencyPairHash } from "./a1-consistency-label-receipt.js";
import { makeConsistencyBlindWorklist } from "./a1-consistency-label-blind-worklist.js";

describe("v2 consistency blind worklist", () => {
  it("keeps only the source pair and its stable binding hash", () => {
    const pair = { id: "cl-1", statement: "A supported claim.", source_text: "The source says this." };
    expect(makeConsistencyBlindWorklist([{ ...pair, topic_id: "topic", source_id: "source", source_body_sha256: "a".repeat(64) }]))
      .toEqual([{ ...pair, pair_sha256: consistencyPairHash(pair) }]);
  });

  it("rejects a leaked label or diagnostic field and duplicate case ids", () => {
    const pair = { id: "cl-1", statement: "A supported claim.", source_text: "The source says this." };
    expect(() => makeConsistencyBlindWorklist([{ ...pair, expected_consistency: "support" }])).toThrow(/标签或生成诊断字段/);
    expect(() => makeConsistencyBlindWorklist([pair, pair])).toThrow(/重复 id/);
  });
});
