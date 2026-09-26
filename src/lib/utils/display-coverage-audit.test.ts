import { describe, expect, it } from "vitest";
import { auditSupportsReaderProjection, auditSupportsReaderStatement, auditSupportsStatementBinding } from "./display-coverage-audit.js";
import { DISPLAY_PROJECTION_VERSION, sourceQuoteHash } from "./source-quote-projection.js";

const quote = "SynAE detects synthetic data.";
const reader = "SynAE 检测合成数据。";
const binding = { citation_index: 1, citation_ref: "cite-1", statement: quote, quote };
const insight = {
  statement: quote, statement_citation_index: 1, headline: "", importance_facts: [],
  importance_basis: "系统重要性判断：该结果可为研究跟踪提供参考。",
  citations: [{ content_item_id: "ci", citation_ref: "cite-1", quote, locator: { paragraph_index: 0, char_start: 0, char_end: quote.length } }],
};
function audit(gate_version: unknown = "display-coverage-v6") {
  return { gate_version, decision: {
    display_projection_version: DISPLAY_PROJECTION_VERSION,
    statement_citation_index: 1, statement_citation_ref: "cite-1",
    statement_sha256: sourceQuoteHash(quote), quote_sha256: sourceQuoteHash(quote), draft_statement_sha256: sourceQuoteHash(reader),
    claims: [{ claim_id: "statement:1", field: "statement", kind: "factual", supports: true, citation_indexes: [1], countercheck: { supports: true } }],
  } };
}

describe("reader audit version compatibility", () => {
  it("keeps current v6 bindings and hash-bound Chinese reader text", () => {
    expect(auditSupportsStatementBinding(audit(), binding)).toBe(true);
    expect(auditSupportsReaderProjection(audit(), insight)).toBe(true);
    expect(auditSupportsReaderStatement(audit(), reader)).toBe(true);
    expect(auditSupportsReaderStatement(audit(), `${reader}额外信息`)).toBe(false);
  });

  it.each([undefined, null, "", "display-coverage-v5", "display-coverage-v9", "display-coverage-v999", "display-coverage-v6 ", 6])(
    "rejects otherwise valid audit with unsupported gate %s", (version) => {
      const candidate = { ...audit(), gate_version: version };
      expect(auditSupportsStatementBinding(candidate, binding)).toBe(false);
      expect(auditSupportsReaderProjection(candidate, insight)).toBe(false);
      expect(auditSupportsReaderStatement(candidate, reader)).toBe(false);
    },
  );

  it("does not treat a supported version as a substitute for hash or independent verdict checks", () => {
    const candidate = audit();
    candidate.decision.quote_sha256 = "wrong";
    expect(auditSupportsReaderProjection(candidate, insight)).toBe(false);
    const noCountercheck = audit();
    noCountercheck.decision.claims[0].countercheck.supports = false;
    expect(auditSupportsReaderProjection(noCountercheck, insight)).toBe(false);
    expect(auditSupportsReaderStatement(noCountercheck, reader)).toBe(false);
  });
});
