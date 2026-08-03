import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdminActor: vi.fn(), getDb: vi.fn(), redactReport: vi.fn() }));
vi.mock("../../../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.requireAdminActor }));
vi.mock("../../../../../../lib/db/index.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../../../../../lib/services/report-redaction.js", () => ({ redactReport: mocks.redactReport }));

import { POST } from "./route.js";

const params = Promise.resolve({ id: "rep_123" });
const request = (body: unknown) => new Request("http://x/api/admin/reports/rep_123/redaction", { method: "POST", body: JSON.stringify(body) });
const body = { deletion_request_id: "delete_req_123", reason_code: "privacy_request", expiry_at: "2027-08-03T00:00:00.000Z" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdminActor.mockResolvedValue({ id: "admin", role: "admin" });
  mocks.getDb.mockReturnValue({});
  mocks.redactReport.mockResolvedValue({ kind: "redacted", record_id: "record_123", already_redacted: false });
  process.env.REDACTION_REGISTRY_BUCKET = "bucket";
  process.env.REDACTION_REGISTRY_KMS_KEY_ID = "kms";
  process.env.REDACTION_HMAC_SECRET_ARN = "secret";
  process.env.REDACTION_HMAC_KEY_VERSION = "v1";
});

describe("POST /api/admin/reports/:id/redaction", () => {
  it("rejects non-admin", async () => {
    mocks.requireAdminActor.mockResolvedValue(null);
    const response = await POST(request(body), { params });
    expect(response.status).toBe(403);
  });

  it("fails closed when registry config is absent", async () => {
    delete process.env.REDACTION_REGISTRY_BUCKET;
    const response = await POST(request(body), { params });
    expect(response.status).toBe(503);
    expect(mocks.redactReport).not.toHaveBeenCalled();
  });

  it("delegates a valid admin deletion request", async () => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, record_id: "record_123", already_redacted: false });
    expect(mocks.redactReport).toHaveBeenCalledWith({}, expect.objectContaining({ report_id: "rep_123", actor_id: "admin" }), expect.any(Object), expect.any(Object));
  });
});
