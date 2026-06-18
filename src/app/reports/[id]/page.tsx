import { notFound } from "next/navigation";
import { auth } from "../../../auth.js";
import { getDb } from "../../../lib/db/index.js";
import { listFollowups } from "../../../lib/db/followup.js";
import { getReport, listBlockedChecksForReport } from "../../../lib/db/reports.js";
import { Markdown } from "../../_components/markdown.js";
import { CitePreview } from "./_components/cite-preview.js";
import { ExportPptButton } from "./_components/export-ppt-button.js";
import { FollowupPanel } from "./_components/followup-panel.js";

export const dynamic = "force-dynamic";

/** 屏蔽理由 → 简短中文标签（未知值原样回显，永远不丢信息）。 */
const REASON_LABEL: Record<string, string> = {
  exaggeration: "夸大",
  out_of_context: "脱离上下文",
  misattribution: "张冠李戴",
  uncertain: "存疑",
  source_not_found: "找不到源",
  source_unreachable: "源不可达",
  quote_not_in_source: "引用不在源中",
  not_evaluated: "未评估",
};

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isAdmin = (await auth())?.user?.role === "admin"; // PPT 导出/追问烧钱 → 仅 admin（middleware 同步硬拦）
  const db = getDb();
  const report = getReport(db, id);
  if (!report) notFound();
  const blocked = listBlockedChecksForReport(db, id);
  const followups = listFollowups(db, id);

  // 按 insight 分组（保持 SQL 顺序）
  const byInsight = new Map<string, { statement: string; rows: typeof blocked }>();
  for (const b of blocked) {
    if (!byInsight.has(b.insight_id)) byInsight.set(b.insight_id, { statement: b.statement, rows: [] });
    byInsight.get(b.insight_id)!.rows.push(b);
  }

  return (
    <section>
      <CitePreview />
      <p className="report-header muted">
        <a href="/reports">← 报告库</a>
        {isAdmin ? <ExportPptButton reportId={id} /> : null}
      </p>
      <Markdown md={report.body_md} />
      <hr />
      <p className="muted">
        {report.type} · 纳入 {report.insight_ids.length} 洞察 / {report.citation_count} 引用 · 生成于{" "}
        {report.generated_at}
        {report.cost ? ` · 成本 $${report.cost.amount.toFixed(4)}` : ""}
      </p>

      {blocked.length === 0 ? null : (
        <details className="audit">
          <summary>校验下钻 · validator 屏蔽 {blocked.length} 条（点击展开）</summary>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            以下引用经独立校验器（opus-4-7）判定 <code>verdict=blocked</code> 而被发布层剔除——
            报告里看不到，但它们是&ldquo;100% 可达 by construction&rdquo;真实把关的证据。
          </p>
          {[...byInsight.entries()].map(([iid, g]) => (
            <article className="card audit-card" key={iid}>
              <p className="muted">
                <strong>洞察</strong> <code>{iid}</code>：{g.statement.slice(0, 80)}
                {g.statement.length > 80 ? "…" : ""}
              </p>
              {g.rows.map((b) => (
                <div className="audit-row" key={`${iid}-${b.citation_index}`}>
                  <p>
                    <span className="audit-reason">{REASON_LABEL[b.reason] ?? b.reason}</span>{" "}
                    <span className="muted">
                      （
                      {b.reachability === "fail"
                        ? `可达性 ${b.reachability_reason}`
                        : `一致性 ${b.consistency} · ${b.consistency_reason}`}
                      ）
                    </span>
                  </p>
                  <blockquote>「{b.quote}」</blockquote>
                  <p className="muted">
                    来源：<code>{b.content_item_id}</code>
                  </p>
                </div>
              ))}
            </article>
          ))}
        </details>
      )}

      {report.status === "done" ? (
        <>
          <hr />
          <FollowupPanel reportId={id} initial={followups} canAsk={isAdmin} />
        </>
      ) : null}
    </section>
  );
}
