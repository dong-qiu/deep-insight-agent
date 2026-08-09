import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../../lib/db/provenance.js", () => ({
  hashIdempotencyKey: vi.fn(() => "hash"), retryFailedTraceRequest: vi.fn(),
}));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../../lib/auth-guard.js";
import { retryFailedTraceRequest } from "../../../../../../lib/db/provenance.js";
import { POST } from "./route.js";

function call(id = "trace_failed", key = "abcdefgh"): Promise<Response> {
  return POST(new Request("http://x", { method: "POST", headers: { "Idempotency-Key": key } }), { params: Promise.resolve({ id }) });
}

describe("POST /api/admin/generation-traces/[id]/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "test-secret";
    process.env.DISPATCH_WORKER_SECRET = "dispatch-secret";
  });

  it("enforces the admin boundary before retry registration", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(retryFailedTraceRequest).not.toHaveBeenCalled();
  });

  it("requires an idempotency key and configured dispatch worker", async () => {
    expect((await call("trace_failed", "short")).status).toBe(400);
    delete process.env.DISPATCH_WORKER_SECRET;
    expect((await call()).status).toBe(503);
  });

  it("creates a linked retry or replays the same request", async () => {
    vi.mocked(retryFailedTraceRequest).mockReturnValueOnce({ kind: "accepted", traceId: "trace_retry", requestId: "req_retry" });
    const accepted = await call();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      trace_id: "trace_retry", request_id: "req_retry", status: "accepted", replayed: false, retry_of_trace_id: "trace_failed",
    });

    vi.mocked(retryFailedTraceRequest).mockReturnValueOnce({ kind: "replayed", traceId: "trace_retry", requestId: "req_retry" });
    expect((await call()).status).toBe(200);
  });

  it("does not retry missing, non-terminal, or active traces", async () => {
    vi.mocked(retryFailedTraceRequest).mockReturnValueOnce({ kind: "not_found" });
    expect((await call()).status).toBe(404);
    vi.mocked(retryFailedTraceRequest).mockReturnValueOnce({ kind: "not_retryable", status: "running", requestState: "accepted" });
    expect((await call()).status).toBe(409);
    vi.mocked(retryFailedTraceRequest).mockReturnValueOnce({ kind: "conflict", activeTraceId: "trace_active" });
    const conflict = await call();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "active_generation", active_trace_id: "trace_active" });
  });

  it("returns a sanitized 503 when durable retry registration cannot run", async () => {
    vi.mocked(retryFailedTraceRequest).mockImplementationOnce(() => { throw new Error("corrupt payload"); });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "dispatch_unavailable" });
  });
});
