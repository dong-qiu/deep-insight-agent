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
  binding: { citation_index: number | null; citation_ref: string | null },
): boolean {
  if (!Number.isInteger(binding.citation_index) || binding.citation_index == null || binding.citation_index < 1 || !binding.citation_ref) return false;
  if (!decision || typeof decision !== "object") return false;
  const record = decision as { statement_citation_index?: unknown; statement_citation_ref?: unknown; claims?: unknown };
  if (record.statement_citation_index !== binding.citation_index || record.statement_citation_ref !== binding.citation_ref) return false;
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
    && statementClaims[0].citation_indexes[0] === binding.citation_index;
}
