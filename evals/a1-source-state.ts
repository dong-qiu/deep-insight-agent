import { createHash } from "node:crypto";

/**
 * The input is deliberately byte-oriented: a porcelain-only hash proves merely that the same
 * paths were dirty, not that the evaluated source was the same. Diff bytes cover tracked
 * changes; untracked files are recorded independently because Git diff cannot see them.
 */
export interface DirtySourceSnapshot {
  status: Buffer | string | null;
  staged_diff?: Buffer | string | null;
  unstaged_diff?: Buffer | string | null;
  untracked?: ReadonlyArray<{ path: string; content: Buffer | string | null }>;
}

export const DIRTY_SOURCE_FINGERPRINT_ALGORITHM = "git-diff-and-untracked-sha256-v2";

const bytes = (value: Buffer | string | null | undefined): Buffer => {
  if (value == null) return Buffer.from("<unavailable>", "utf8");
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
};

function appendPart(hash: ReturnType<typeof createHash>, label: string, value: Buffer | string | null | undefined): void {
  const data = bytes(value);
  hash.update(label, "utf8");
  hash.update("\0", "utf8");
  hash.update(String(data.length), "utf8");
  hash.update("\0", "utf8");
  hash.update(data);
  hash.update("\0", "utf8");
}

/** Return null only for a known-clean checkout. Unknown Git state is itself fingerprinted. */
export function dirtyFingerprintFromSnapshot(snapshot: DirtySourceSnapshot): string | null {
  const status = snapshot.status;
  if (status != null && bytes(status).length === 0) return null;
  const hash = createHash("sha256");
  appendPart(hash, "algorithm", DIRTY_SOURCE_FINGERPRINT_ALGORITHM);
  appendPart(hash, "status", status);
  appendPart(hash, "staged_diff", snapshot.staged_diff);
  appendPart(hash, "unstaged_diff", snapshot.unstaged_diff);
  for (const file of [...(snapshot.untracked ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    appendPart(hash, `untracked_path:${file.path}`, file.content);
  }
  return hash.digest("hex");
}

/** Compatibility shim for older call sites. New A1 runs must use the content snapshot API. */
export function dirtyFingerprintFromStatus(status: string | null): string | null {
  return dirtyFingerprintFromSnapshot({ status });
}
