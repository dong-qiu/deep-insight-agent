import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), dashboardWindow: vi.fn(), db: {}, page: vi.fn(), notFound: vi.fn() }));
vi.mock("../../../../auth.js", () => ({ auth: mocks.auth }));
vi.mock("../../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../../../lib/db/p1-dashboard.js", () => ({ dashboardWindow: mocks.dashboardWindow }));
vi.mock("../../../../lib/runtime/p1-dashboard-runtime.js", () => ({ p1DashboardEnabled: () => true }));
vi.mock("../../../../lib/db/p1-metrics-facts.js", () => ({ listMetricDetailsPage: mocks.page }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import MetricsDetailsPage from "./page.js";

describe("MetricsDetailsPage", () => {
  beforeEach(() => {
    mocks.auth.mockReset().mockResolvedValue({ user: { id: "admin_detail", role: "admin" } });
    mocks.audit.mockReset();
    mocks.dashboardWindow.mockReset().mockReturnValue({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
    mocks.page.mockReset().mockReturnValue({ items: [], next: null });
    mocks.notFound.mockReset().mockImplementation(() => { throw new Error("not_found"); });
  });

  it("audits an authorized server-rendered detail read before loading details", async () => {
    await MetricsDetailsPage({ searchParams: Promise.resolve({ kind: "funnel" }) });

    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, { actor: "admin_detail", action: "dashboard_detail_read", target: "dashboard_detail", detail: expect.objectContaining({ allowed: true, target_type: "dashboard_detail", tenant: "default", reason_code: "authorized", request_id: expect.any(String) }) });
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.page.mock.invocationCallOrder[0]);
  });

  it("does not read or audit details when the session is not an admin", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(MetricsDetailsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("not_found");
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });
});
