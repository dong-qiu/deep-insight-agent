import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), db: vi.fn(), audit: vi.fn(), conclusion: vi.fn(), hold: vi.fn(), deletion: vi.fn() }));
vi.mock("../../../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.actor }));
vi.mock("../../../../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../../../../lib/db/index.js", () => ({ getDb: mocks.db }));
vi.mock("../../../../../../lib/db/integrity-lifecycle.js", () => ({
  retentionConclusionForAdmin: mocks.conclusion, recordLegalHold: mocks.hold, requestReportDeletion: mocks.deletion,
}));

import { GET, POST } from "./route.js";

const params = Promise.resolve({ id: "report_123" });
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ id: "admin_1", role: "admin" });
  mocks.db.mockReturnValue({ db: true });
  mocks.conclusion.mockReturnValue({ conclusion: "内容保留期已结束，原始内容不再可验证", destroyed_at: "2026-02-02T00:00:00.000Z" });
  mocks.hold.mockReturnValue(true);
  mocks.deletion.mockReturnValue({ kind: "delete_pending" });
});

describe("report retention lifecycle handler", () => {
  it("gives admins only the redacted destroyed conclusion", async () => {
    const response = await GET(new Request("http://x"), { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conclusion: { conclusion: "内容保留期已结束，原始内容不再可验证", destroyed_at: "2026-02-02T00:00:00.000Z" } });
  });

  it("makes viewer, cross-tenant, and missing reports indistinguishable", async () => {
    mocks.actor.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://x"), { params })).status).toBe(404);
    expect((await post({ action: "place_hold", tenant_id: "other", hold_id: "hold_123", reason_code: "legal_request" })).status).toBe(404);
    expect((await post({ action: "place_hold", tenant_id: "default", hold_id: "hold_123", reason_code: "legal_request" })).status).toBe(404);
    mocks.conclusion.mockReturnValueOnce(null);
    expect((await GET(new Request("http://x"), { params })).status).toBe(404);
    expect(mocks.audit).toHaveBeenCalledWith({ db: true }, expect.objectContaining({ action: "retention_lifecycle_denied", detail: expect.objectContaining({ reason_code: "authorization_denied" }) }));
  });

  it("executes an admin lifecycle request with a server-owned actor and tenant", async () => {
    const response = await post({ action: "place_hold", hold_id: "hold_123", reason_code: "legal_request" });
    expect(response.status).toBe(200);
    expect(mocks.hold).toHaveBeenCalledWith({ db: true }, { report_id: "report_123", hold_id: "hold_123", action: "placed", actor_id: "admin_1", reason_code: "legal_request" });
  });
});
