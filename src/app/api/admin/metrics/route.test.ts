import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), audit: vi.fn(), db: {}, metrics: vi.fn(), integrity: vi.fn() }));
vi.mock("../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.actor }));
vi.mock("../../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../../../lib/db/p1-dashboard.js", () => ({
  dashboardWindow: vi.fn(() => ({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" })),
  readP1DashboardMetrics: mocks.metrics,
  readIntegrityDashboardStatus: mocks.integrity,
}));

import { GET } from "./route.js";

describe("GET /api/admin/metrics", () => {
  beforeEach(() => {
    mocks.actor.mockReset().mockResolvedValue({ id: "admin_1", role: "admin" });
    mocks.audit.mockReset(); mocks.metrics.mockReset().mockReturnValue({ funnel: [] }); mocks.integrity.mockReset().mockReturnValue({ latest_daily_root: null, recent_events: [] });
  });

  it("returns bounded admin-only metrics and isolates integrity diagnostic failure", async () => {
    mocks.integrity.mockImplementation(() => { throw new Error("unavailable"); });
    const response = await GET(new Request("http://x/api/admin/metrics?from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ metrics: { funnel: [] }, integrity: null, diagnostics: { metrics: "available", integrity: "unavailable" } });
    expect(mocks.metrics).toHaveBeenCalledWith(mocks.db, { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, { actor: "admin_1", action: "dashboard_read", target: "dashboard", detail: expect.objectContaining({ allowed: true, target_type: "dashboard", tenant: "default", reason_code: "authorized", request_id: expect.any(String) }) });
  });

  it("does not disclose the dashboard to a viewer or unauthenticated caller", async () => {
    mocks.actor.mockResolvedValue(null);
    const response = await GET(new Request("http://x/api/admin/metrics?from=2026-08-01T00:00:00.000Z"));
    expect(response.status).toBe(404);
    expect(mocks.metrics).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, { actor: "anonymous", action: "dashboard_read_denied", target: "dashboard", detail: expect.objectContaining({ allowed: false, target_type: "dashboard", tenant: "default", reason_code: "authorization_denied", request_id: expect.any(String) }) });
  });
});
