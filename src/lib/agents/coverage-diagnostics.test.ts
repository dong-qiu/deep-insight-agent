import { describe, expect, it } from "vitest";
import { coverageDiagnostic } from "./coverage-diagnostics.js";
import type { CoverageDecision } from "./analyzer.js";

describe("coverageDiagnostic whitelist", () => {
  it("keeps only controlled codes and valid hashes, never raw text/errors/excerpts", () => {
    const decision: CoverageDecision = {
      candidate_id: "PRIVATE ID", gate_version: "display-coverage-v6", terminal_reason: "dropped_coverage",
      input_hash: "PRIVATE BAD HASH", quote_sha256: "a".repeat(64), statement_citation_claim: "PRIVATE CLAIM",
      reader_language_repair: { status: "rejected", prompt_hash: "c".repeat(64), source_draft_sha256: "b".repeat(64),
        source_audit_input_hash: "d".repeat(64), source_claims: [{ claim_id: "statement:1", field: "statement", text: "PRIVATE original",
          kind: "factual", supports: true, reason: "judge_supported", citation_indexes: [], evidence_spans: [] }] },
      claims: [{ claim_id: "x", field: "statement", kind: "factual", text: "PRIVATE TEXT", supports: false,
        citation_indexes: [], evidence_spans: [], reason: "primary_unavailable",
        countercheck: { model: "x", prompt_version: "x", prompt_hash: "", input_hash: "", checked_at: "",
          supports: false, reason: "PRIVATE REASON", citation_indexes: [], evidence_spans: [], error: "PRIVATE ERROR" },
      }],
    };
    const result = coverageDiagnostic(decision);
    expect(result).toMatchObject({ terminal_reason: "dropped_coverage", claim_reasons: ["primary_unavailable"],
      countercheck_reasons: ["unknown"], input_hash: null, quote_sha256: "a".repeat(64) });
    expect(result.candidate_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reader_language_repair).toEqual({ status: "rejected", prompt_hash: "c".repeat(64), source_draft_sha256: "b".repeat(64), source_audit_input_hash: "d".repeat(64), translated_draft_sha256: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
