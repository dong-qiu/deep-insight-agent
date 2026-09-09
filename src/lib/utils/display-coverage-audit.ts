import type { Insight } from "../types.js";
import { DISPLAY_PROJECTION_VERSION, isExactSourceQuoteProjection, sourceQuoteHash } from "./source-quote-projection.js";

type AuditClaim = {
  claim_id?: unknown;
  field?: unknown;
  kind?: unknown;
  supports?: unknown;
  citation_indexes?: unknown;
};

function factualClaims(decision: unknown): AuditClaim[] | null {
  if (!decision || typeof decision !== "object") return null;
  const claims = (decision as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return null;
  const factual = claims.filter((claim): claim is AuditClaim => Boolean(claim) && typeof claim === "object"
    && (claim as AuditClaim).kind === "factual");
  return factual.length ? factual : null;
}

/** Return every citation still required by a kept display audit. An unreadable or incomplete
 * decision fails closed: a durable audit may never be treated as a generic insight-level pass. */
export function requiredAuditCitationIndexes(audit: { decision: unknown }): Set<number> | null {
  const factual = factualClaims(audit.decision);
  if (!factual || factual.some((claim) => claim.supports !== true || !Array.isArray(claim.citation_indexes) || claim.citation_indexes.length === 0)) return null;
  const required = new Set<number>();
  for (const claim of factual) {
    for (const index of claim.citation_indexes as unknown[]) {
      if (!Number.isInteger(index) || (index as number) < 1) return null;
      required.add((index as number) - 1);
    }
  }
  return required;
}

/** A graph/drill card publishes only the persisted statement binding. Verify that the kept audit
 * made exactly that same binding before trusting a stored terminal label. */
export function auditSupportsStatementBinding(
  decision: unknown,
  binding: { citation_index: number | null; citation_ref: string | null; statement: string; quote: string },
): boolean {
  if (!Number.isInteger(binding.citation_index) || binding.citation_index == null || binding.citation_index < 1 || !binding.citation_ref) return false;
  if (!decision || typeof decision !== "object") return false;
  const record = decision as {
    statement_citation_index?: unknown; statement_citation_ref?: unknown; claims?: unknown;
    display_projection_version?: unknown; statement_sha256?: unknown; quote_sha256?: unknown;
  };
  if (record.statement_citation_index !== binding.citation_index || record.statement_citation_ref !== binding.citation_ref) return false;
  if (record.display_projection_version !== DISPLAY_PROJECTION_VERSION
    || !isExactSourceQuoteProjection(binding.statement, binding.quote)
    || record.statement_sha256 !== sourceQuoteHash(binding.statement)
    || record.quote_sha256 !== sourceQuoteHash(binding.quote)) return false;
  const required = requiredAuditCitationIndexes({ decision });
  if (!required?.has(binding.citation_index - 1) || !Array.isArray(record.claims)) return false;
  const statementClaims = record.claims.filter((claim): claim is AuditClaim => Boolean(claim) && typeof claim === "object"
    && (claim as AuditClaim).claim_id === "statement:1"
    && (claim as AuditClaim).field === "statement"
    && (claim as AuditClaim).kind === "factual");
  return statementClaims.length === 1
    && statementClaims[0].supports === true
    && Array.isArray(statementClaims[0].citation_indexes)
    && statementClaims[0].citation_indexes.length === 1
    && statementClaims[0].citation_indexes[0] === binding.citation_index
    // v6 requires the independent quote-only judge in addition to the primary coverage verdict.
    && Boolean((statementClaims[0] as AuditClaim & { countercheck?: { supports?: unknown } }).countercheck?.supports === true);
}
/** The only reader-visible importance copy allowed beside a source quote. Keep this closed
 * vocabulary here so persisted consumers cannot accept an arbitrary system-prefixed sentence. */
const CONTROLLED_IMPORTANCE_BASIS = new Set([
  "系统重要性判断：该结果可为工程选型提供参考。",
  "系统重要性判断：该结果可为安全审查提供参考。",
  "系统重要性判断：该结果可为评测解读提供参考。",
  "系统重要性判断：该结果可为研究跟踪提供参考。",
]);

/** Reader-visible derivatives may not revive generated titles, facts, or arbitrary rationale
 * from a historical insight. This check is deliberately independent of citation persistence so
 * database read paths can apply it before hydrating an entire Insight object. */
export function hasSafeReaderMetadata(input: Pick<Insight, "headline" | "importance_facts" | "importance_basis">): boolean {
  return !input.headline?.trim()
    && !(input.importance_facts ?? []).some((fact) => fact.trim())
    && CONTROLLED_IMPORTANCE_BASIS.has(input.importance_basis);
}

/** Shared persistence boundary for every reader-visible derivative. A correct statement hash is
 * insufficient if a stale headline or free-text importance field can reintroduce facts. */
export function auditSupportsReaderProjection(
  decision: unknown,
  insight: Pick<Insight, "statement" | "statement_citation_index" | "citations" | "headline" | "importance_facts" | "importance_basis">,
): boolean {
  const citationIndex = insight.statement_citation_index;
  const citation = citationIndex == null ? undefined : insight.citations[citationIndex - 1];
  return Boolean(citation)
    && auditSupportsStatementBinding(decision, {
      citation_index: citationIndex ?? null,
      citation_ref: citation!.citation_ref ?? null,
      statement: insight.statement,
      quote: citation!.quote,
    })
    && hasSafeReaderMetadata(insight);
}
