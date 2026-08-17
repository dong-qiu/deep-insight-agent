import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../lib/db/provenance.js", () => ({ getGenerationTraceStatus: vi.fn(), listGenerationTraceTimelinePage: vi.fn(() => ({ items: [], nextCursor: null, truncated: false })) }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../lib/auth-guard.js";
import { getGenerationTraceStatus, listGenerationTraceTimelinePage } from "../../../../lib/db/provenance.js";
import { GET } from "./route.js";

const call = (): Promise<Response> => GET(new Request("http://x/api/generation-traces/trace_1"), {
  params: Promise.resolve({ id: "trace_1" }),
});

describe("GET /api/generation-traces/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enforces the admin boundary before looking up a trace", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(getGenerationTraceStatus).not.toHaveBeenCalled();
  });

  it("returns only the stable reason code, never the stored error message", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getGenerationTraceStatus).mockReturnValue({
      trace_id: "trace_1", request_id: "req_1", status: "failed", root_run_id: "run_1",
      started_at: "2026-08-03T00:00:00.000Z", ended_at: "2026-08-03T00:01:00.000Z", coverage: "complete",
      dispatch_state: "failed", attempt: 1, claimed_at: "2026-08-03T00:00:01.000Z", lease_expires_at: null,
      runtime_version: JSON.stringify({ schema_version: 1, git_sha: "a".repeat(40), image_digest: `sha256:${"b".repeat(64)}`, provenance_schema_version: "20260803_06_provenance_facts", secret: "do-not-leak" }),
      last_error: JSON.stringify({ reason_code: "dispatch_failed", message: "private upstream exception" }),
    });

    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dispatch.last_error_reason).toBe("dispatch_failed");
    expect(body.runtime).toEqual({ schema_version: 1, git_sha: "a".repeat(40), image_digest: `sha256:${"b".repeat(64)}`, provenance_schema_version: "20260803_06_provenance_facts" });
    expect(JSON.stringify(body)).not.toContain("private upstream exception");
    expect(JSON.stringify(body)).not.toContain("do-not-leak");
    expect(listGenerationTraceTimelinePage).toHaveBeenCalledWith({}, "trace_1", { limit: 50, afterSequence: 0 });
  });

  it("uses the deployment record at trace time for legacy traces without a runtime snapshot", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getGenerationTraceStatus).mockReturnValue({
      trace_id: "trace_1", request_id: null, status: "done", root_run_id: "run_1",
      started_at: "2026-08-03T00:00:00.000Z", ended_at: "2026-08-03T00:01:00.000Z", coverage: "complete",
      dispatch_state: "done", attempt: 1, claimed_at: "2026-08-03T00:00:01.000Z", lease_expires_at: null,
      runtime_version: "{}", deployment_git_sha: "c".repeat(40), deployment_image_digest: `sha256:${"d".repeat(64)}`,
    });

    const body = await (await call()).json();
    expect(body.runtime).toEqual({ git_sha: "c".repeat(40), image_digest: `sha256:${"d".repeat(64)}` });
  });

  it("rejects unbounded or malformed pagination before opening the database", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    const response = await GET(new Request("http://x/api/generation-traces/trace_1?limit=101"), { params: Promise.resolve({ id: "trace_1" }) });
    expect(response.status).toBe(400);
    expect(getGenerationTraceStatus).not.toHaveBeenCalled();
  });
});
