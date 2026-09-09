/** Route handler test：v6 原文证据 export 不支持自由 LLM 润色参数。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../../../lib/services/ppt-export.js", () => ({ exportReportPptx: vi.fn() }));
vi.mock("../../../../../lib/auth-guard.js", () => ({ forbidNonAdmin: vi.fn() }));

import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { exportReportPptx } from "../../../../../lib/services/ppt-export.js";
import { GET } from "./route.js";

const callGet = (url: string, id: string): Promise<Response> => GET(new Request(url), { params: Promise.resolve({ id }) });

describe("GET /api/reports/[id]/pptx", () => {
  it("非 admin（二道闸 403）→ 直接 403、不导出", async () => {
    vi.mocked(forbidNonAdmin).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const res = await callGet("http://x/api/reports/r1/pptx", "r1");
    expect(res.status).toBe(403);
    expect(exportReportPptx).not.toHaveBeenCalled();
  });

  it("polish/refresh 是明确弃用参数，拒绝而不静默降级", async () => {
    const res = await callGet("http://x/api/reports/r1/pptx?polish=1&refresh=1", "r1");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "ppt_polish_not_supported_in_source_quote_v6" });
    expect(exportReportPptx).not.toHaveBeenCalled();
  });

  it("不存在的报告 → 404 + JSON error", async () => {
    vi.mocked(exportReportPptx).mockResolvedValue(null);
    const res = await callGet("http://x/api/reports/nope/pptx", "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "report_not_found" });
  });

  it("成功 → PPT headers/body，且不暴露已移除的 polish headers", async () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]);
    vi.mocked(exportReportPptx).mockResolvedValue({
      buffer, pageCount: 6,
      // @ts-expect-error test stub only needs route fields
      report: { id: "rep_x" }, topic: { name: "T" },
      polishCost: { tokens: 0, amount: 0 }, polishCache: "none", polishStatus: "none",
      polishCoverage: { perInsightDone: 0, perInsightTotal: 0, hasExecutive: false },
      polishAborted: false, polishCostCapUsd: 0, fileName: "T · 2026-06-07.pptx",
    });
    const res = await callGet("http://x/api/reports/rep_x/pptx", "rep_x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''T%20%C2%B7%202026-06-07.pptx");
    expect(res.headers.get("X-Ppt-Page-Count")).toBe("6");
    expect(res.headers.get("X-Ppt-Polish-Cache")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(buffer);
    expect(exportReportPptx).toHaveBeenCalledWith(expect.anything(), "rep_x");
  });

  it("orchestrator 抛错 → 500 + JSON error", async () => {
    vi.mocked(exportReportPptx).mockRejectedValue(new Error("db corrupted"));
    const res = await callGet("http://x/api/reports/x/pptx", "x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db corrupted" });
  });
});
