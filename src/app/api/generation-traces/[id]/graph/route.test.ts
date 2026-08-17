import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));
vi.mock("../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../lib/db/provenance.js", () => ({ getGenerationTraceStatus: vi.fn(), buildGenerationTraceGraph: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { buildGenerationTraceGraph, getGenerationTraceStatus } from "../../../../../lib/db/provenance.js";
import { GET } from "./route.js";

describe("GET /api/generation-traces/[id]/graph", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks admin authorization before opening the database", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const response = await GET(new Request("http://x/api/generation-traces/t/graph"), { params: Promise.resolve({ id: "t" }) });
    expect(response.status).toBe(403);
    expect(getGenerationTraceStatus).not.toHaveBeenCalled();
  });

  it("rejects graph budgets outside the P0c ceiling", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    const response = await GET(new Request("http://x/api/generation-traces/t/graph?depth=5"), { params: Promise.resolve({ id: "t" }) });
    expect(response.status).toBe(400);
    expect(getGenerationTraceStatus).not.toHaveBeenCalled();
  });

  it("passes only bounded graph budgets to the read model", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(null);
    vi.mocked(getGenerationTraceStatus).mockReturnValue({ trace_id: "t" });
    vi.mocked(buildGenerationTraceGraph).mockReturnValue({ nodes: [], edges: [], truncated: false, truncation_reason: null });
    const response = await GET(new Request("http://x/api/generation-traces/t/graph?depth=4&max_elements=500&root_sequence=7"), { params: Promise.resolve({ id: "t" }) });
    expect(response.status).toBe(200);
    expect(buildGenerationTraceGraph).toHaveBeenCalledWith({}, "t", { depth: 4, maxElements: 500, rootSequence: 7 });
  });
});
