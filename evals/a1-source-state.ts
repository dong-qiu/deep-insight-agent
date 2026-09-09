import { createHash } from "node:crypto";

/** A clean porcelain result is a meaningful state, distinct from an unavailable git command. */
export function dirtyFingerprintFromStatus(status: string | null): string | null {
  if (status === "") return null;
  return createHash("sha256").update(status ?? "unavailable").digest("hex");
}
