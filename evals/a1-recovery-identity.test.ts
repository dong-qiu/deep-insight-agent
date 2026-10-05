import { expect, it } from "vitest";
import { a1RecoveryIdentity, a1SourceIdentityComplete, a1HasNewTruncatedOutput, A1_RECOVERY_ENV_KEYS } from "./a1-recovery-identity.js";
import { DIRTY_SOURCE_FINGERPRINT_ALGORITHM } from "./a1-source-state.js";

const source = { commit: "a".repeat(40), dirty_fingerprint: null, dirty_fingerprint_algorithm: DIRTY_SOURCE_FINGERPRINT_ALGORITHM, identity_complete: true };
const observed = { sampled_at: "2026-10-05", analyzer_model: "synthetic-a", sdk_retries: 2, topic_timeout_ms: 30000 };

it("binds verified clean/dirty source and judgment code without binding sampling time or credentials", () => {
  const identity = a1RecoveryIdentity(source, observed, {});
  expect(identity).toMatch(/^[a-f0-9]{64}$/);
  expect(a1RecoveryIdentity(source, { ...observed, sampled_at: "later" }, { LLM_API_KEY: "PRIVATE-SENSITIVE", UNKNOWN: "PRIVATE-TEXT" })).toBe(identity);
  for (const change of [{ commit: "b".repeat(40) }, { dirty_fingerprint: "b".repeat(64) }]) {
    expect(a1RecoveryIdentity({ ...source, ...change }, observed, {})).not.toBe(identity);
  }
  expect(a1RecoveryIdentity(source, { ...observed, sdk_retries: 0 }, {})).not.toBe(identity);
});

it.each(A1_RECOVERY_ENV_KEYS)("binds runtime condition %s without publishing raw values", (key) => {
  const identity = a1RecoveryIdentity(source, observed, { [key]: "PRIVATE-ENDPOINT-OR-CONFIG" });
  expect(identity).not.toBe(a1RecoveryIdentity(source, observed, {}));
  expect(identity).not.toContain("PRIVATE");
});

it("distinguishes complete source capture from a hash of missing bytes", () => {
  const snapshot = { status: Buffer.alloc(0), staged_diff: Buffer.alloc(0), unstaged_diff: Buffer.alloc(0), untracked: [{ path: "synthetic", content: Buffer.from("data") }] };
  expect(a1SourceIdentityComplete(source.commit, snapshot, Buffer.from("synthetic\0"))).toBe(true);
  for (const key of ["status", "staged_diff", "unstaged_diff"] as const) {
    expect(a1SourceIdentityComplete(source.commit, { ...snapshot, [key]: null }, Buffer.alloc(0))).toBe(false);
  }
  expect(a1SourceIdentityComplete(null, snapshot, Buffer.alloc(0))).toBe(false);
  expect(a1SourceIdentityComplete(source.commit, snapshot, null)).toBe(false);
  expect(a1SourceIdentityComplete(source.commit, { ...snapshot, untracked: [{ path: "synthetic", content: null }] }, Buffer.alloc(0))).toBe(false);
  expect(a1RecoveryIdentity({ ...source, identity_complete: false, dirty_fingerprint: "c".repeat(64) }, observed, {})).toBeNull();
  expect(a1RecoveryIdentity({ ...source, commit: null }, observed, {})).toBeNull();
  expect(a1RecoveryIdentity({ ...source, dirty_fingerprint_algorithm: "unknown" }, observed, {})).toBeNull();
});

it("detects new provider truncation across operations, without treating successful retries as incomplete", () => {
  const before = { analyzer: { output_stop_reasons: { max_tokens: 1, completed: 2 } } };
  expect(a1HasNewTruncatedOutput(before, { analyzer: { output_stop_reasons: { max_tokens: 1, completed: 3 } } })).toBe(false);
  expect(a1HasNewTruncatedOutput(before, { analyzer: { output_stop_reasons: { max_tokens: 2 } } })).toBe(true);
  expect(a1HasNewTruncatedOutput(before, { coverage: { output_stop_reasons: { max_output_tokens: 1 } } })).toBe(true);
});
