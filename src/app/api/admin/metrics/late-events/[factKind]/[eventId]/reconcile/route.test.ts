import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), reconcile: vi.fn(), notify: vi.fn(), db: {}, enabled: vi.fn() }));
vi.mock("../../../../../../../../lib/auth-guard.js", () => ({ requireAdminActor: mocks.actor }));
vi.mock("../../../../../../../../lib/db/index.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../../../../../../../lib/db/p1-metrics-facts.js", () => ({ reconcileLateMetricEvent: mocks.reconcile }));
vi.mock("../../../../../../../../lib/runtime/metric-alert.js", () => ({ notifyMetricLateReconciliation: mocks.notify }));
vi.mock("../../../../../../../../lib/runtime/p1-dashboard-runtime.js", () => ({ p1DashboardEnabled: mocks.enabled }));

import { POST } from "./route.js";

describe("POST metric late-event reconciliation", () => {
  beforeEach(() => { mocks.actor.mockReset(); mocks.reconcile.mockReset(); mocks.notify.mockReset(); mocks.enabled.mockReset().mockReturnValue(true); });

  it("requires an admin and records/notifies an explicit backfill", async () => {
    mocks.actor.mockResolvedValue({ id: "admin_1", role: "admin" }); mocks.reconcile.mockReturnValue({ id: "mlr_1" });
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "backfilled" }) }), { params: Promise.resolve({ factKind: "cost", eventId: "entry_1" }) });
    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.db, { fact_kind: "cost", event_id: "entry_1", action: "backfilled", actor_id: "admin_1" });
    expect(mocks.notify).toHaveBeenCalledWith({ eventId: "entry_1", action: "backfilled", actorId: "admin_1" });
  });

  it("does not expose or reconcile a missing late event", async () => {
    mocks.actor.mockResolvedValue({ id: "admin_1", role: "admin" }); mocks.reconcile.mockImplementation(() => { throw new Error("metric_late_event_not_found"); });
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "declined" }) }), { params: Promise.resolve({ factKind: "funnel", eventId: "event_1" }) });
    expect(response.status).toBe(404); expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not reconcile while the P1 dashboard gate is closed", async () => {
    mocks.actor.mockResolvedValue({ id: "admin_1", role: "admin" }); mocks.enabled.mockReturnValue(false);
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "backfilled" }) }), { params: Promise.resolve({ factKind: "cost", eventId: "entry_1" }) });
    expect(response.status).toBe(404); expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("uses the same 404 for anonymous callers", async () => {
    mocks.actor.mockResolvedValue(null);
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "backfilled" }) }), { params: Promise.resolve({ factKind: "cost", eventId: "entry_1" }) });
    expect(response.status).toBe(404); expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
