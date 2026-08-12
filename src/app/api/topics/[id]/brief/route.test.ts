/** P0b-2a 单主题日报：只持久受理，由 worker 异步执行。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../lib/db/repos.js", () => ({ getTopic: vi.fn() }));
vi.mock("../../../../../lib/db/provenance.js", () => ({
  hashIdempotencyKey: vi.fn(() => "hash"), createScheduledTraceRequest: vi.fn(),
}));
vi.mock("../../../../../lib/auth-guard.js", () => ({ requireAdminActor: vi.fn() }));

import { requireAdminActor } from "../../../../../lib/auth-guard.js";
import { createScheduledTraceRequest } from "../../../../../lib/db/provenance.js";
import { getTopic } from "../../../../../lib/db/repos.js";
import { POST } from "./route.js";

function call(id: string, key = "abcdefgh"): Promise<Response> {
  return POST(new Request("http://x", { method: "POST", headers: { "Idempotency-Key": key } }), { params: Promise.resolve({ id }) });
}

describe("POST /api/topics/[id]/brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdminActor).mockResolvedValue({ id: "admin_1", role: "admin" });
    process.env.AUTH_SECRET = "test-secret";
    process.env.DISPATCH_WORKER_SECRET = "dispatch-secret";
    delete process.env.PIPELINE_WINDOW_HOURS;
    delete process.env.PIPELINE_ITEMS_PER_TOPIC;
  });

  it("non-admin short-circuits before persistence", async () => {
    vi.mocked(requireAdminActor).mockResolvedValueOnce(null);
    expect((await call("t1")).status).toBe(403);
    expect(getTopic).not.toHaveBeenCalled();
  });

  it("requires a valid Idempotency-Key and configured worker", async () => {
    expect((await call("t1", "short")).status).toBe(400);
    delete process.env.DISPATCH_WORKER_SECRET;
    expect((await call("t1")).status).toBe(503);
    expect(getTopic).not.toHaveBeenCalled();
  });

  it("does not accept a missing or disabled topic", async () => {
    expect((await call("missing")).status).toBe(404);
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "off", name: "Off", enabled: false });
    expect((await call("off")).status).toBe(409);
    expect(createScheduledTraceRequest).not.toHaveBeenCalled();
  });

  it("durably accepts one configured Daily Brief for this UTC period", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    vi.mocked(createScheduledTraceRequest).mockReturnValue({ kind: "accepted", traceId: "trace_1", requestId: "req_1" });
    process.env.PIPELINE_WINDOW_HOURS = "72";
    process.env.PIPELINE_ITEMS_PER_TOPIC = "9";
    const response = await call("t1");
    expect(response.status).toBe(202);
    expect(createScheduledTraceRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      topicId: "t1", reportType: "brief", windowHours: 72, items: 9,
      triggerKind: "api", actorId: "admin_1", idempotencyKeyHash: "hash",
      period: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }));
    expect(await response.json()).toEqual({ trace_id: "trace_1", request_id: "req_1", status: "accepted", replayed: false, report_type: "brief" });
  });

  it("returns the canonical daily replay or active conflict", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    vi.mocked(createScheduledTraceRequest).mockReturnValueOnce({ kind: "replayed", traceId: "trace_1", requestId: "req_1" });
    const replay = await call("t1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "replayed", replayed: true });
    vi.mocked(createScheduledTraceRequest).mockReturnValueOnce({ kind: "conflict", activeTraceId: "trace_active" });
    const conflict = await call("t1", "ijklmnop");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "active_generation", active_trace_id: "trace_active" });
  });
});
