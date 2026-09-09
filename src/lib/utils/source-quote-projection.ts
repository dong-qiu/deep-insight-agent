import { createHash } from "node:crypto";

/** P0 reader contract: a displayed insight is the exact text of one bound source quote. */
export const DISPLAY_PROJECTION_VERSION: "source_quote_v1" = "source_quote_v1";

/** This is deliberately byte-exact. NFC/whitespace normalization would make the stored reader
 * statement a different representation from the source evidence it claims to display. */
export function sourceQuoteHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isExactSourceQuoteProjection(statement: string, quote: string): boolean {
  return statement === quote;
}
