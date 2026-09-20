import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../../../auth.js";
import { getDb } from "../../../../../lib/db/index.js";
import { getPublishedReportReview, listPublishedReportReviewDecisions } from "../../../../../lib/db/report-review.js";
import { safeExternalUrl } from "../../../../../lib/utils/safe-external-url.js";
import { ProvenanceTimeline } from "../../../../reports/[id]/_components/provenance-timeline.js";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
const cap = (value: unknown, max = 180) => typeof value === "string" ? value.slice(0, max) : "";
const countOf = (row: unknown): number => {
  const value = (row as { count?: unknown } | undefined)?.count;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
};
const pageNumber = (value: string | string[] | undefined): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
};
const parseRecord = (value: string): Record<string, string | number> => {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string" || typeof item === "number") result[key] = item;
    }
    return result;
  } catch { return {}; }
};

function PageNav({ reportId, param, page, total }: { reportId: string; param: string; page: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return null;
  const href = (target: number) => `/admin/reports/${reportId}/review?${param}=${target}`;
  return <p className="muted">第 {page} / {pages} 页（共 {total} 条） {page > 1 ? <Link href={href(page - 1)}>上一页</Link> : null}{page > 1 && page < pages ? " · " : null}{page < pages ? <Link href={href(page + 1)}>下一页</Link> : null}</p>;
}

/** Server-side admin gate in addition to the /admin middleware. The page only
 * reads bounded metadata DTOs: no body/raw/prompt/audit decision JSON leaves DB. */
export default async function ReportQualityReviewPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await auth())?.user?.role !== "admin") notFound();
  const { id } = await params;
  const query = await searchParams;
  const db = getDb();
  const review = getPublishedReportReview(db, id);
  if (!review) notFound();

  const inputPage = pageNumber(query.inputs_page);
  const decisionPage = pageNumber(query.decisions_page);
  const checkPage = pageNumber(query.checks_page);
  const candidatePage = pageNumber(query.candidates_page);
  const snapshot = db.prepare(`SELECT analyze_started_event_id,analyze_completed_event_id,validate_started_event_id,validate_completed_event_id,generate_report_started_event_id
    FROM report_review_snapshot WHERE report_id=? AND publication_state='published'`).get(id) as {
    analyze_started_event_id: string; analyze_completed_event_id: string; validate_started_event_id: string; validate_completed_event_id: string; generate_report_started_event_id: string;
  } | undefined;
  if (!snapshot) notFound(); // defensive: getPublishedReportReview and this bound read must agree

  const inputCount = countOf(db.prepare(`SELECT COUNT(*) AS count FROM generation_entity_ref er
    JOIN provenance_revision pr ON pr.entity_type=er.entity_type AND pr.entity_key=er.entity_key AND pr.revision=er.revision
    WHERE er.trace_id=? AND er.event_id=? AND er.role='input' AND er.entity_type='content_item'`).get(review.trace_id, snapshot.analyze_started_event_id));
  const inputs = db.prepare(`SELECT pr.snapshot FROM generation_entity_ref er
    JOIN provenance_revision pr ON pr.entity_type=er.entity_type AND pr.entity_key=er.entity_key AND pr.revision=er.revision
    WHERE er.trace_id=? AND er.event_id=? AND er.role='input' AND er.entity_type='content_item'
    ORDER BY er.rowid LIMIT ? OFFSET ?`).all(review.trace_id, snapshot.analyze_started_event_id, PAGE_SIZE, (inputPage - 1) * PAGE_SIZE) as Array<{ snapshot: string }>;
  const snapshots = inputs.map((row) => {
    const value = parseRecord(row.snapshot);
    const rawUrl = typeof value.url === "string" ? value.url : "";
    const url = cap(rawUrl, 300);
    return { title: cap(value.title), url, href: safeExternalUrl(rawUrl), source_id: cap(value.source_id, 80), published_at: value.published_at, fetched_at: value.fetched_at, body_kind: value.body_kind, fetch_status: value.fetch_status, body_length: value.body_length, content_hash: value.content_hash };
  });

  const decisionRows = listPublishedReportReviewDecisions(db, id, { limit: PAGE_SIZE, offset: (decisionPage - 1) * PAGE_SIZE });
  if (!decisionRows) notFound();
  const candidateCount = countOf(db.prepare("SELECT COUNT(*) AS count FROM display_coverage_candidate_audit WHERE batch_id=?").get(review.analysis_batch_id));
  const candidates = db.prepare(`SELECT candidate_id,insight_id,gate_version,terminal_reason,prompt_version,input_hash,validator_model,created_at
    FROM display_coverage_candidate_audit WHERE batch_id=? ORDER BY created_at,candidate_id LIMIT ? OFFSET ?`).all(
    review.analysis_batch_id, PAGE_SIZE, (candidatePage - 1) * PAGE_SIZE,
  ) as Array<Record<string, string | null>>;
  const checkCount = countOf(db.prepare(`SELECT COUNT(*) AS count FROM citation c
    JOIN insight i ON i.id=c.insight_id
    JOIN citation_check cc ON cc.batch_id=i.batch_id AND cc.insight_id=c.insight_id AND cc.citation_index=c.citation_index
    WHERE i.id IN (SELECT insight_id FROM report_selection_decision WHERE report_id=?)`).get(id));
  const checks = db.prepare(`SELECT c.insight_id,c.citation_index,c.quote,c.locator,cc.verdict,cc.reachability_reason,cc.consistency_reason
    FROM citation c JOIN insight i ON i.id=c.insight_id JOIN citation_check cc ON cc.batch_id=i.batch_id AND cc.insight_id=c.insight_id AND cc.citation_index=c.citation_index
    WHERE i.id IN (SELECT insight_id FROM report_selection_decision WHERE report_id=?)
    ORDER BY c.insight_id,c.citation_index LIMIT ? OFFSET ?`).all(id, PAGE_SIZE, (checkPage - 1) * PAGE_SIZE) as Array<Record<string, string | number>>;

  // Read only event IDs frozen by the published snapshot. In particular, do
  // not pick a retry's configuration merely because it shares this trace.
  const eventRows = db.prepare("SELECT id,stage,version_context,metrics FROM generation_event WHERE id IN (?,?,?,?,?)").all(
    snapshot.analyze_started_event_id, snapshot.analyze_completed_event_id, snapshot.validate_started_event_id, snapshot.validate_completed_event_id, snapshot.generate_report_started_event_id,
  ) as Array<{ id: string; stage: string; version_context: string; metrics: string }>;
  const events = new Map(eventRows.map((event) => [event.id, event]));
  const frozen = [
    { label: "分析", config: parseRecord(events.get(snapshot.analyze_started_event_id)?.version_context ?? "{}"), metrics: parseRecord(events.get(snapshot.analyze_completed_event_id)?.metrics ?? "{}") },
    { label: "校验", config: parseRecord(events.get(snapshot.validate_started_event_id)?.version_context ?? "{}"), metrics: parseRecord(events.get(snapshot.validate_completed_event_id)?.metrics ?? "{}") },
    { label: "报告生成", config: parseRecord(events.get(snapshot.generate_report_started_event_id)?.version_context ?? "{}"), metrics: parseRecord(events.get(snapshot.generate_report_started_event_id)?.metrics ?? "{}") },
  ];

  return <section>
    <p><Link href={`/reports/${id}`}>← 返回报告</Link></p>
    <h1>报告质量复盘</h1>
    <p className="muted">{review.report_title} · 规则 {review.selection_rule_version} · 复盘包 {review.created_at}</p>
    <ProvenanceTimeline traceId={review.trace_id} showBriefFunnel={review.report_type === "brief"} />
    <details className="audit" open><summary>分析输入快照 · 本页 {snapshots.length} / {inputCount}</summary>
      <table className="stats"><thead><tr><th>标题</th><th>来源</th><th>抓取</th><th>形态/状态</th><th>长度</th><th>内容哈希</th></tr></thead><tbody>
        {snapshots.map((item, index) => <tr key={`${String(item.content_hash)}-${index}`}><td>{item.href ? <a href={item.href} target="_blank" rel="noreferrer">{item.title || item.url}</a> : item.title || item.url}</td><td>{String(item.source_id ?? "")}</td><td>{String(item.published_at ?? item.fetched_at ?? "")}</td><td>{String(item.body_kind ?? "")} / {String(item.fetch_status ?? "")}</td><td>{String(item.body_length ?? "")}</td><td><code>{String(item.content_hash ?? "").slice(0, 16)}</code></td></tr>)}
      </tbody></table><PageNav reportId={id} param="inputs_page" page={inputPage} total={inputCount} />
    </details>
    <details className="audit" open><summary>最终选择账本 · 本页 {decisionRows.items.length} / {decisionRows.total}</summary>
      <table className="stats"><thead><tr><th>洞察</th><th>结果</th><th>原因</th><th>关联洞察</th><th>排序</th><th>支持引用</th></tr></thead><tbody>
        {decisionRows.items.map((decision) => <tr key={decision.insight_id}><td><code>{cap(decision.insight_id, 128)}</code></td><td>{decision.decision}</td><td>{cap(decision.reason_code, 96)}</td><td><code>{cap(decision.related_insight_id, 128) || "—"}</code></td><td>{decision.published_rank ?? "—"}</td><td>{decision.supporting_citation_indices.length ? <>{decision.supporting_citation_indices.slice(0, 20).join(", ")}{decision.supporting_citation_indices.length > 20 ? " …" : ""}</> : "—"}</td></tr>)}
      </tbody></table><PageNav reportId={id} param="decisions_page" page={decisionPage} total={decisionRows.total} />
    </details>
    <details className="audit"><summary>引用校验 · 本页 {checks.length} / {checkCount}</summary>
      <table className="stats"><thead><tr><th>洞察</th><th>引用</th><th>结论</th><th>理由</th><th>短引文 / 定位</th></tr></thead><tbody>
        {checks.map((check) => <tr key={`${check.insight_id}-${check.citation_index}`}><td><code>{cap(check.insight_id, 32)}</code></td><td>{check.citation_index}</td><td>{cap(check.verdict, 32)}</td><td>{cap(check.reachability_reason, 48)} / {cap(check.consistency_reason, 48)}</td><td><q>{cap(check.quote, 240)}</q> <span className="muted">{cap(check.locator, 120)}</span></td></tr>)}
      </tbody></table><PageNav reportId={id} param="checks_page" page={checkPage} total={checkCount} />
    </details>
    <details className="audit"><summary>冻结运行配置与缓存观测</summary>
      {frozen.map((entry) => <div key={entry.label}><p><strong>{entry.label}</strong>：{Object.entries(entry.config).length ? Object.entries(entry.config).map(([key, value]) => <code key={key} style={{ marginLeft: "0.5rem" }}>{cap(key, 48)}={cap(String(value), 80)}</code>) : <span className="muted">未冻结（legacy / partial）</span>}</p>
        {entry.label === "分析" && entry.metrics.analysis_cache_read_bypassed === 1 ? <p className="muted">本轮未查读缓存；hit/miss 的 0/0 不代表未命中。</p> : null}
        {entry.label === "分析" && entry.metrics.analysis_cache_read_bypassed === 0 ? <p className="muted">缓存 item：命中 {String(entry.metrics.analysis_cache_hit_item_count ?? 0)}，未命中 {String(entry.metrics.analysis_cache_miss_item_count ?? 0)}。</p> : null}
      </div>)}
    </details>
    <details className="audit"><summary>覆盖候选元数据 · 本页 {candidates.length} / {candidateCount}</summary>
      <p className="muted">仅展示受控元数据；模型候选文本和内部 decision JSON 不会在此页输出。</p>
      <table className="stats"><thead><tr><th>候选</th><th>洞察</th><th>终态</th><th>门版本</th><th>模型</th><th>输入哈希</th></tr></thead><tbody>
        {candidates.map((candidate) => <tr key={candidate.candidate_id ?? ""}><td><code>{cap(candidate.candidate_id, 48)}</code></td><td><code>{cap(candidate.insight_id, 48) || "—"}</code></td><td>{cap(candidate.terminal_reason, 64)}</td><td>{cap(candidate.gate_version, 64)}</td><td>{cap(candidate.validator_model, 80)}</td><td><code>{cap(candidate.input_hash, 16)}</code></td></tr>)}
      </tbody></table><PageNav reportId={id} param="candidates_page" page={candidatePage} total={candidateCount} />
    </details>
  </section>;
}
