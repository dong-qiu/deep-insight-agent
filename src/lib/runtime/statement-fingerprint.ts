/** Strict Insight statement identity: typography/whitespace only, never semantic similarity. */
import { compareKey } from "./text-normalize.js";

export const statementFingerprint = (statement: string): string => compareKey(statement);

/** A statement has no event identity without its Insight kind. */
export const insightFingerprint = (type: "aggregation" | "trend" | undefined, statement: string): string =>
  `${type ?? "unknown"}\x00${statementFingerprint(statement)}`;
