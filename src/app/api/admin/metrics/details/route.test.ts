import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), audit: vi.fn(), page: vi.fn(), db: {}, enabled: vi.fn() }));
vi.mock("../../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.actor }));
vi.mock("../../../../../lib/db/audit.js", () => ({ appendAudit: mocks.audit }));
vi.mock("../../../../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../../../../lib/db/p1-metrics-facts.js", () => ({ listMetricDetailsPage: mocks.page }));
vi.mock("../../../../../lib/runtime/p1-dashboard-runtime.js", () => ({ p1DashboardEnabled: mocks.enabled }));
import { GET } from "./route.js";

describe("GET /api/admin/metrics/details", () => {
  const url = "http://x/api/admin/metrics/details?kind=funnel&from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z";
  beforeEach(() => { mocks.actor.mockReset().mockResolvedValue({ id: "admin_1" }); mocks.audit.mockReset(); mocks.page.mockReset().mockReturnValue({ items: [{ event_id: "event_2" }], next: { occurred_at: "2026-08-01T01:00:00.000Z", id: "event_2" } }); mocks.enabled.mockReset().mockReturnValue(true); });

  it("returns a bounded protected page and emits an opaque versioned cursor", async () => {
    const response = await GET(new Request(`${url}&limit=100`));
    expect(response.status).toBe(200);
    const body = await response.json() as { next_cursor: string; items: unknown[] };
    expect(body.items).toEqual([{ event_id: "event_2" }]);
    expect(body.next_cursor).not.toContain("event_2");
    expect(mocks.page).toHaveBeenCalledWith(mocks.db, expect.objectContaining({ kind: "funnel", limit: 100, cursor: null }));
    expect(mocks.audit).toHaveBeenCalledWith(mocks.db, expect.objectContaining({ actor: "admin_1", action: "dashboard_detail_read" }));
  });

  it("uses the same public 404 for anonymous callers and never reads detail", async () => {
    mocks.actor.mockResolvedValue(null);
    const response = await GET(new Request(url));
    expect(response.status).toBe(404); expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects an invalid or mismatched cursor without disclosing detail", async () => {
    const cursor = Buffer.from(JSON.stringify({ cursor_version: 1, kind: "cost", from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", as_of: "2026-08-02T00:00:00.000Z", occurred_at: "2026-08-01T00:00:00.000Z", id: "x" })).toString("base64url");
    const response = await GET(new Request(`${url}&cursor=${cursor}`));
    expect(response.status).toBe(400); expect(mocks.page).not.toHaveBeenCalled();
  });

  it("hides details while the P1 dashboard gate is closed", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await GET(new Request(url))).status).toBe(404);
    expect(mocks.page).not.toHaveBeenCalled();
  });
});
