/** Route handler test：直接 import GET 注入 mock params + Request，不经 middleware。
 *  覆盖：404 不存在 / 200 成功（headers + body）/ polish=1 透传给 orchestrator。 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../lib/db/index.js", () => ({
  getDb: vi.fn(() => ({ /* opaque DB handle, orchestrator 被 mock 不会实际用 */ })),
}));
vi.mock("../../../../../lib/services/ppt-export.js", () => ({
  exportReportPptx: vi.fn(),
}));

import { exportReportPptx } from "../../../../../lib/services/ppt-export.js";
import { GET } from "./route.js";

function callGet(url: string, id: string): Promise<Response> {
  return GET(new Request(url), { params: Promise.resolve({ id }) });
}

describe("GET /api/reports/[id]/pptx", () => {
  it("orchestrator 返 null → 404 + JSON error", async () => {
    vi.mocked(exportReportPptx).mockResolvedValue(null);
    const res = await callGet("http://x/api/reports/nope/pptx", "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "report_not_found" });
  });

  it("成功 → 200 + .pptx headers + buffer body", async () => {
    const fakeBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]);
    vi.mocked(exportReportPptx).mockResolvedValue({
      buffer: fakeBuf, pageCount: 6,
      // @ts-expect-error 测试 stub：只填路由用到的字段
      report: { id: "rep_x" }, topic: { name: "T" },
      polishCost: { tokens: 0, amount: 0 },
      fileName: "T · 2026-06-07.pptx",
    });
    const res = await callGet("http://x/api/reports/rep_x/pptx", "rep_x");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    // RFC 5987 编码非 ASCII 文件名
    expect(res.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''T%20%C2%B7%202026-06-07.pptx",
    );
    expect(res.headers.get("X-Ppt-Page-Count")).toBe("6");
    expect(res.headers.get("X-Ppt-Polish-Cost-Usd")).toBe("0.000000");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(fakeBuf);
    // 默认无 polish=1 → orchestrator 收到 usePolish:false
    expect(exportReportPptx).toHaveBeenCalledWith(expect.anything(), "rep_x", { usePolish: false });
  });

  it("?polish=1 → 透传 usePolish:true + 成本 header 体现", async () => {
    vi.mocked(exportReportPptx).mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]), pageCount: 7,
      // @ts-expect-error 测试 stub
      report: { id: "rep_x" }, topic: { name: "T" },
      polishCost: { tokens: 8817, amount: 0.0712 },
      fileName: "T.pptx",
    });
    const res = await callGet("http://x/api/reports/rep_x/pptx?polish=1", "rep_x");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ppt-Polish-Tokens")).toBe("8817");
    expect(res.headers.get("X-Ppt-Polish-Cost-Usd")).toBe("0.071200");
    expect(exportReportPptx).toHaveBeenCalledWith(expect.anything(), "rep_x", { usePolish: true });
  });

  it("orchestrator 抛错 → 500 + JSON error", async () => {
    vi.mocked(exportReportPptx).mockRejectedValue(new Error("db corrupted"));
    const res = await callGet("http://x/api/reports/x/pptx", "x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db corrupted" });
  });
});
