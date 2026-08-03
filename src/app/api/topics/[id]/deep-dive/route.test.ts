/** P0a Deep Dive 受理：只持久登记，绝不在 Web 路由内启动 Promise。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../lib/db/repos.js", () => ({ getTopic: vi.fn() }));
vi.mock("../../../../../lib/db/provenance.js", () => ({
  hashIdempotencyKey: vi.fn(() => "hash"), createDeepDiveTraceRequest: vi.fn(),
}));
vi.mock("../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { createDeepDiveTraceRequest } from "../../../../../lib/db/provenance.js";
import { getTopic } from "../../../../../lib/db/repos.js";
import { POST } from "./route.js";

function call(id: string, key = "abcdefgh"): Promise<Response> {
  return POST(new Request("http://x", { method: "POST", headers: { "Idempotency-Key": key } }), { params: Promise.resolve({ id }) });
}

describe("POST /api/topics/[id]/deep-dive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "test-secret";
    process.env.DISPATCH_WORKER_SECRET = "dispatch-secret";
  });

  it("non-admin short-circuits before persistence", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await call("t1")).status).toBe(403);
    expect(getTopic).not.toHaveBeenCalled();
  });

  it("requires a valid Idempotency-Key", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    expect((await call("t1", "short")).status).toBe(400);
  });

  it("fails closed before accepting work when the dispatch worker secret is absent", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    delete process.env.DISPATCH_WORKER_SECRET;
    expect((await call("t1")).status).toBe(503);
    expect(createDeepDiveTraceRequest).not.toHaveBeenCalled();
  });

  it("returns 202 only after durable acceptance", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    vi.mocked(createDeepDiveTraceRequest).mockReturnValue({ kind: "accepted", traceId: "trace_1", requestId: "req_1" });
    const response = await call("t1");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ trace_id: "trace_1", request_id: "req_1", status: "accepted", replayed: false });
  });

  it("replays the same registration and exposes active conflict", async () => {
    // @ts-expect-error minimal route stub
    vi.mocked(getTopic).mockReturnValue({ id: "t1", name: "T", enabled: true });
    vi.mocked(createDeepDiveTraceRequest).mockReturnValueOnce({ kind: "replayed", traceId: "trace_1", requestId: "req_1" });
    expect((await call("t1")).status).toBe(200);
    vi.mocked(createDeepDiveTraceRequest).mockReturnValueOnce({ kind: "conflict", activeTraceId: "trace_active" });
    const conflict = await call("t1", "ijklmnop");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "active_generation", active_trace_id: "trace_active" });
  });
});
