/** POST /api/admin/sources/[id]/collect —— 数据源按需立即抓取（C-3 · data-collection AC8）。
 *
 *  spec 明确："对指定源发起按需触发，能立即执行一次抓取，不等定时周期"。
 *  - 复用 collectSource（runJob 内置：落 Run + 失败告警 + retry_of 链路）；
 *  - **fire-and-forget**（review #3 对称 C-1）：单源抓取理论 <30s 但 RSS 5xx + safe-fetch
 *    重试 + 高产源 backlog 可能远超浏览器/curl 默认超时；UI 看 /admin 进度更稳；
 *  - 鉴权由 middleware 拦截；runtime=nodejs。 */
import { NextResponse } from "next/server";
import { collectSource } from "../../../../../../lib/agents/collector.js";
import { getDb } from "../../../../../../lib/db/index.js";
import { getSource, hasRunningRun } from "../../../../../../lib/db/repos.js";
import { runLogger } from "../../../../../../lib/runtime/logger.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const source = getSource(db, id);
  if (!source) return NextResponse.json({ error: "source_not_found" }, { status: 404 });
  if (!source.enabled) {
    return NextResponse.json(
      { error: "source_disabled", message: `源 ${id} 已停用，启用后再抓取` },
      { status: 409 },
    );
  }
  if (hasRunningRun(db, "ingest", "source_id", id)) {
    return NextResponse.json(
      {
        error: "already_running",
        message: `源 ${id} 已有 ingest Run 在跑——等当前轮结束再触发。`,
      },
      { status: 409 },
    );
  }

  const startedAt = new Date().toISOString();
  const log = runLogger({ stage: "collect-ondemand" });
  log.info(`用户触发立即抓取（fire-and-forget · source=${id}）`);

  // fire-and-forget：collectSource 内部 runJob 立刻 INSERT Run，UI 可立即在 /admin 看到 running。
  // 失败由 runJob 标 failed + notifyFailure 兜底；这里 promise rejection 进 logger 不阻塞 response。
  void collectSource(db, source).then(
    (out) => log.info({ runId: out.runId, fetched: out.fetched, inserted: out.inserted }, "立即抓取完成"),
    (e) => log.error({ err: (e as Error).message }, "立即抓取失败（runJob 已落 failed Run）"),
  );

  return NextResponse.json(
    {
      status: "started",
      source_id: id,
      source_name: source.name,
      started_at: startedAt,
      message: "抓取已启动；新条目落库后会通过 /admin 看板可见，下次管线会自动纳入分析。",
    },
    { status: 202 },
  );
}
