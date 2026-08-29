import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), dashboardWindow: vi.fn(), db: {}, integrity: vi.fn(), metrics: vi.fn(), notFound: vi.fn() }));
vi.mock("../../../auth.js", () => ({ auth: mocks.auth }));
vi.mock("../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../../lib/db/p1-dashboard.js", () => ({ dashboardWindow: mocks.dashboardWindow, readIntegrityDashboardStatus: mocks.integrity, readP1DashboardMetrics: mocks.metrics }));
vi.mock("../../../lib/runtime/p1-dashboard-runtime.js", () => ({ p1DashboardEnabled: () => true }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import MetricsDashboard from "./page.js";

describe("MetricsDashboard", () => {
  beforeEach(() => {
    mocks.auth.mockReset().mockResolvedValue({ user: { id: "admin_page", role: "admin" } });
    mocks.audit.mockReset();
    mocks.dashboardWindow.mockReset().mockReturnValue({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
    mocks.metrics.mockReset().mockReturnValue({ funnel: [], funnel_loss_reasons: [], costs: [], validator_reasons: [], latency: [], latency_diagnostics: { completed_traces: 0, in_progress_traces: 0, negative_clock_samples: 0, missing_clock_samples: 0 } });
    mocks.integrity.mockReset().mockReturnValue({ latest_daily_root: null, recent_events: [] });
    mocks.notFound.mockReset().mockImplementation(() => { throw new Error("not_found"); });
  });

  it("audits an authorized server-rendered dashboard read with its trusted actor", async () => {
    await MetricsDashboard();

    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, { actor: "admin_page", action: "dashboard_read", target: "dashboard", detail: expect.objectContaining({ allowed: true, target_type: "dashboard", tenant: "default", reason_code: "authorized", request_id: expect.any(String) }) });
    expect(mocks.metrics).toHaveBeenCalledWith(mocks.db, { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
  });

  it("does not read or audit the dashboard when the session is not an admin", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(MetricsDashboard()).rejects.toThrow("not_found");

    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.metrics).not.toHaveBeenCalled();
  });
});
