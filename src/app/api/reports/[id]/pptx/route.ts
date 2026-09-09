/** GET /api/reports/{id}/pptx —— 下载确定性 v6 原文证据 deck。
 * 自由 LLM 润色会把非来源文本伪装成报告内容，因此不再支持 polish/refresh 参数。 */
import { NextResponse } from "next/server";
import { forbidNonAdmin } from "../../../../../lib/auth-guard.js";
import { getDb } from "../../../../../lib/db/index.js";
import { exportReportPptx } from "../../../../../lib/services/ppt-export.js";

export const dynamic = "force-dynamic";
// pptxgenjs 依赖 Node API（Buffer/zip），不可在 Edge 跑——显式锁 Node 运行时
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await forbidNonAdmin(); // 二道闸：PPT 导出（B 路径 polish 烧钱），非 admin 直接 403
  if (denied) return denied;
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  if (sp.has("polish") || sp.has("refresh")) {
    return NextResponse.json({ error: "ppt_polish_not_supported_in_source_quote_v6" }, { status: 422 });
  }

  let result;
  try {
    result = await exportReportPptx(getDb(), id);
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
      "X-Ppt-Page-Count": String(result.pageCount),
    },
  });
}
