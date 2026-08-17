import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../../../lib/db/provenance.js", () => ({ getGenerationTraceStatus: vi.fn(), listGenerationEventRefs: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../../../lib/auth-guard.js";
import { getGenerationTraceStatus, listGenerationEventRefs } from "../../../../../../../lib/db/provenance.js";
import { GET } from "./route.js";

describe("GET /api/generation-traces/[id]/events/[sequence]/refs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks admin authorization before opening the database", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const response = await GET(new Request("http://x/api/generation-traces/t/events/1/refs"), { params: Promise.resolve({ id: "t", sequence: "1" }) });
    expect(response.status).toBe(403);
    expect(getGenerationTraceStatus).not.toHaveBeenCalled();
  });

  it("enforces pagination caps and returns a bounded refs page", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getGenerationTraceStatus).mockReturnValue({ trace_id: "t" });
    vi.mocked(listGenerationEventRefs).mockReturnValue({ items: [], nextCursor: null, truncated: false });
    const response = await GET(new Request("http://x/api/generation-traces/t/events/1/refs?limit=100"), { params: Promise.resolve({ id: "t", sequence: "1" }) });
    expect(response.status).toBe(200);
    expect(listGenerationEventRefs).toHaveBeenCalledWith({}, "t", 1, { limit: 100, afterRowId: 0 });
  });
});
