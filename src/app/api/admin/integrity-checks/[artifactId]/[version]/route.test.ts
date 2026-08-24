import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), db: vi.fn(), audit: vi.fn(), store: vi.fn(), verify: vi.fn(), notify: vi.fn(), notifyOnce: vi.fn(), alertedWindows: new Set<string>() }));
vi.mock("../../../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.actor }));
vi.mock("../../../../../../lib/db/index.js", () => ({ getDb: mocks.db }));
vi.mock("../../../../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../../../../lib/db/integrity-checks.js", () => ({ verifyArtifactIntegrity: mocks.verify, notifyIntegrityFailureOnce: mocks.notifyOnce }));
vi.mock("../../../../../../lib/runtime/integrity-anchor-runtime.js", () => ({ deploymentAnchorVerificationStore: mocks.store }));
vi.mock("../../../../../../lib/runtime/integrity-alert.js", () => ({ notifyIntegrityFailure: mocks.notify }));

import { POST } from "./route.js";

beforeEach(() => {
  mocks.actor.mockReset().mockResolvedValue({ id: "admin", role: "admin" });
  mocks.db.mockReset().mockReturnValue({ db: true }); mocks.audit.mockReset(); mocks.store.mockReset().mockReturnValue({ store: true });
  mocks.verify.mockReset().mockResolvedValue({ artifact_id: "artifact-1", artifact_version: "v1", outcome: "pass", failure_step: null, expected_hash_prefix: null, actual_hash_prefix: null, checked_at: "2026-08-22T00:00:00Z" });
  mocks.notify.mockReset();
  mocks.alertedWindows.clear();
  mocks.notifyOnce.mockReset().mockImplementation((_db, checked, notify) => {
    if (checked.outcome === "pass") return false;
    const window = new Date(Math.floor(Date.parse(checked.checked_at) / (30 * 60_000)) * (30 * 60_000)).toISOString();
    const key = `${checked.artifact_id}:${checked.artifact_version}:${window}`;
    if (mocks.alertedWindows.has(key)) return false;
    mocks.alertedWindows.add(key); notify(checked); return true;
  });
});
const call = (artifactId = "artifact-1", version = "v1") => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ artifactId, version }) });

describe("POST /api/admin/integrity-checks/:artifact/:version", () => {
  it("requires admin and returns the redacted check record", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, check: { outcome: "pass" } });
    expect(mocks.verify).toHaveBeenCalledWith({ db: true }, { store: true }, { artifact_id: "artifact-1", artifact_version: "v1" });
    expect(mocks.audit).toHaveBeenCalledWith({ db: true }, expect.objectContaining({ actor: "admin", action: "integrity_check_requested", target: "artifact-1@v1" }));
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not disclose artifacts to non-admin callers", async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith({ db: true }, { action: "integrity_check_denied", target: "integrity_check", detail: { reason_code: "authorization_denied" } });
  });

  it("deduplicates repeated on-demand failures in the 30 minute notification window", async () => {
    const failed = { artifact_id: "artifact-1", artifact_version: "v1", outcome: "anchor_mismatch", failure_step: "anchor", expected_hash_prefix: null, actual_hash_prefix: null, key_revoked: false };
    mocks.verify
      .mockResolvedValueOnce({ ...failed, checked_at: "2026-08-22T00:00:00Z" })
      .mockResolvedValueOnce({ ...failed, checked_at: "2026-08-22T00:05:00Z" })
      .mockResolvedValueOnce({ ...failed, checked_at: "2026-08-22T00:30:00Z" });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect((await call()).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.notifyOnce).toHaveBeenCalledTimes(3);
  });
});
