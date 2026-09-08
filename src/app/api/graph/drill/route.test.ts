import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("../../../../lib/db/graph.js", () => ({
  groupDrillInsights: vi.fn(),
  insightsCooccurring: vi.fn(),
  insightsMentioningEntity: vi.fn(),
  reportLinksByInsight: vi.fn(),
}));

import { NextRequest } from "next/server";
import { getDb } from "../../../../lib/db/index.js";
import { groupDrillInsights, insightsCooccurring, insightsMentioningEntity, reportLinksByInsight } from "../../../../lib/db/graph.js";
import { GET } from "./route.js";

describe("GET /api/graph/drill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires topic and entity before opening the database", async () => {
    const response = await GET(new NextRequest("http://x/api/graph/drill?topic=t"));
    expect(response.status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns read-time groups with every original occurrence and report link", async () => {
    const occurrences = [{ id: "i1" }];
    const links = new Map([["i1", [{ report_id: "r1", date: "2026-09-08" }]]]);
    const groups = [{
      type: "aggregation", statement: "严格相同表述", occurrence_count: 2,
      occurrences: [
        { id: "i1", report_links: links.get("i1") },
        { id: "i2", report_links: [] },
      ],
    }];
    vi.mocked(insightsMentioningEntity).mockReturnValue(occurrences as never);
    vi.mocked(reportLinksByInsight).mockReturnValue(links);
    vi.mocked(groupDrillInsights).mockReturnValue(groups as never);

    const response = await GET(new NextRequest("http://x/api/graph/drill?topic=t&a=OpenAI&since=2026-09-01"));

    expect(response.status).toBe(200);
    expect(insightsMentioningEntity).toHaveBeenCalledWith({ db: true }, "t", "OpenAI", "2026-09-01");
    expect(groupDrillInsights).toHaveBeenCalledWith(occurrences, links);
    await expect(response.json()).resolves.toEqual({ items: groups });
  });

  it("uses cooccurrence lookup when a second entity is provided", async () => {
    vi.mocked(insightsCooccurring).mockReturnValue([] as never);
    vi.mocked(reportLinksByInsight).mockReturnValue(new Map());
    vi.mocked(groupDrillInsights).mockReturnValue([] as never);

    await GET(new NextRequest("http://x/api/graph/drill?topic=t&a=OpenAI&b=Codex"));

    expect(insightsCooccurring).toHaveBeenCalledWith({ db: true }, "t", "OpenAI", "Codex", undefined);
    expect(insightsMentioningEntity).not.toHaveBeenCalled();
  });
});
