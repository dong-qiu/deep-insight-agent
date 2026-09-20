import { describe, expect, it } from "vitest";
import { makeBlindLabelCsv, parseCsv, blindLabelCsvToSubmission, renderCsv, spreadsheetLiteral } from "./a1-consistency-label-csv.js";
import { consistencyPairHash } from "./a1-consistency-label-receipt.js";

const pair = { id: "cl-1", statement: "=Do not execute, \"claim\".", source_text: " @literal, \"source\"\nsecond line" };
const worklist = [{ ...pair, pair_sha256: consistencyPairHash(pair) }];

describe("v2 consistency blind-label CSV", () => {
  it("creates a spreadsheet-safe human worksheet and turns a completed row into a human-only submission", () => {
    const rows = parseCsv(makeBlindLabelCsv(worklist));
    expect(rows[1]?.[2]).toBe(spreadsheetLiteral(pair.statement));
    expect(rows[1]?.[3]).toBe(spreadsheetLiteral(pair.source_text));
    rows[1]![4] = "not_support";
    rows[1]![5] = "exaggeration";
    const submission = blindLabelCsvToSubmission(worklist, renderCsv(rows), "  human-a  ");
    expect(submission).toEqual({
      reviewer_id: "human-a", reviewer_kind: "human", blind_attestation: true,
      decisions: [{ case_id: pair.id, pair_sha256: worklist[0]!.pair_sha256, expected_consistency: "not_support", negative_type: "exaggeration" }],
    });
  });

  it("rejects missing labels, label/type mismatch, or modified evidence cells", () => {
    const blank = parseCsv(makeBlindLabelCsv(worklist));
    expect(() => blindLabelCsvToSubmission(worklist, renderCsv(blank), "human-a")).toThrow(/expected_consistency/);

    const mismatchedType = parseCsv(makeBlindLabelCsv(worklist));
    mismatchedType[1]![4] = "support"; mismatchedType[1]![5] = "exaggeration";
    expect(() => blindLabelCsvToSubmission(worklist, renderCsv(mismatchedType), "human-a")).toThrow(/仅 not_support/);

    const mutatedSource = parseCsv(makeBlindLabelCsv(worklist));
    mutatedSource[1]![3] = "changed"; mutatedSource[1]![4] = "support";
    expect(() => blindLabelCsvToSubmission(worklist, renderCsv(mutatedSource), "human-a")).toThrow(/source_text 已被修改/);
  });
});
