/** GET /api/reports/{id}/pptx?polish=1 —— 把报告导出为 .pptx 下载。
 *  - polish=1 → 跑 B 阶段 LLM 润色（§1 凝练 + §3 启示 + Executive 页，~10s + ~$0.07）；
 *  - 缺省（A 即时导出）：仅确定性骨架 + statement 首句 + importance_basis；零 LLM 成本。
 *  鉴权由 middleware.ts 已统一拦截，未登录走 401。 */
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db/index.js";
import { exportReportPptx } from "../../../../../lib/services/ppt-export.js";

export const dynamic = "force-dynamic";
// pptxgenjs 依赖 Node API（Buffer/zip），不可在 Edge 跑——显式锁 Node 运行时
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const usePolish = new URL(req.url).searchParams.get("polish") === "1";

  let result;
  try {
    result = await exportReportPptx(getDb(), id, { usePolish });
  } catch (e) {
    console.error(`[pptx] 报告 ${id} 导出失败：`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!result) return NextResponse.json({ error: "report_not_found" }, { status: 404 });

  // RFC 5987 编码文件名：中文 + 特殊字符在 Content-Disposition 正确显示
  const encoded = encodeURIComponent(result.fileName);
  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="report.pptx"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(result.buffer.length),
      "Cache-Control": "no-store",
      // 把 polish 成本透传 header，方便 admin/devtools 看
      "X-Ppt-Page-Count": String(result.pageCount),
      "X-Ppt-Polish-Tokens": String(result.polishCost.tokens),
      "X-Ppt-Polish-Cost-Usd": result.polishCost.amount.toFixed(6),
    },
  });
}
