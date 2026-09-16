import { consistencyPairHash } from "./a1-consistency-label-receipt.js";

export interface BlindWorklistCandidate {
  id: string;
  statement: string;
  source_text: string;
}

export interface BlindWorklistRow extends BlindWorklistCandidate {
  pair_sha256: string;
}

/**
 * Create the only pair fields a blind reviewer needs. The generator's source/topic metadata and
 * every label-like field are deliberately excluded, so this output can be given to each reviewer.
 */
export function makeConsistencyBlindWorklist(rows: readonly unknown[]): BlindWorklistRow[] {
  const ids = new Set<string>();
  return rows.map((value, index) => {
    if (value == null || typeof value !== "object") throw new Error(`candidate row ${index} 不是对象`);
    const row = value as Record<string, unknown>;
    if ("expected_consistency" in row || "negative_type" in row || "intent" in row || "rationale" in row) {
      throw new Error(`candidate row ${index} 含标签或生成诊断字段，不能用于盲标`);
    }
    if (typeof row.id !== "string" || !row.id.trim() || typeof row.statement !== "string" || !row.statement.trim()
      || typeof row.source_text !== "string" || !row.source_text.trim()) {
      throw new Error(`candidate row ${index} 缺少 id、statement 或 source_text`);
    }
    if (ids.has(row.id)) throw new Error(`candidate 含重复 id：${row.id}`);
    ids.add(row.id);
    const candidate = { id: row.id, statement: row.statement, source_text: row.source_text };
    return { ...candidate, pair_sha256: consistencyPairHash(candidate) };
  });
}
