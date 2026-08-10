"use client";
import { useEffect, useState } from "react";

interface TimelineEvent { sequence: number; stage: string; event_type: string; attempt: number; occurred_at: string; reason_code?: string; metrics?: Record<string, number>; refs: Array<{ type: string; revision: string; role: string }> }
interface TraceRuntime { image_digest?: string; git_sha?: string; provenance_schema_version?: string; schema_version?: number }
interface TracePayload { timeline: TimelineEvent[]; runtime?: TraceRuntime }
const COUNT_LABEL: Record<string, string> = {
  input_content_count: "分析输入", analysis_insight_count: "产出洞察", no_significant_event: "无重要事件",
  citation_total: "校验引用", citation_pass: "通过", citation_blocked: "拦截", citation_flagged: "存疑", citation_errored: "错误",
  includable_insight_count: "可纳入洞察", releasable: "可发布", freshness_filtered_insight_count: "新鲜度过滤",
  already_published_filtered_insight_count: "已发布去重", supplemental_candidate_count: "补充候选",
  supplemental_published_insight_count: "补充发现", published_insight_count: "发布洞察", published_citation_count: "发布引用",
  candidate_count: "候选", opportunity_count: "机会",
};
const REASON_LABEL: Record<string, string> = {
  no_significant_event: "分析未发现重要事件", no_new_publishable_insight: "没有新增且可发布的洞察",
  no_publishable_insight: "没有可发布的洞察",
};
function metricsText(metrics?: Record<string, number>): string | null {
  if (!metrics) return null;
  const values = Object.entries(metrics).filter(([key]) => COUNT_LABEL[key]).map(([key, value]) => `${COUNT_LABEL[key]} ${value}`);
  return values.length ? values.join(" · ") : null;
}
function briefFunnelText(timeline: TimelineEvent[]): string | null {
  const report = [...timeline].reverse().find((event) => event.stage === "generate_report" && event.event_type === "completed");
  if (!report?.metrics || report.metrics.includable_insight_count === undefined) return null;
  const analyze = timeline.find((event) => event.stage === "analyze" && event.event_type === "completed")?.metrics;
  const m = report.metrics;
  const count = (value: number | undefined): string => value === undefined ? "—" : String(value);
  return `日报选择漏斗：分析产出 ${count(analyze?.analysis_insight_count)} → 可纳入 ${count(m.includable_insight_count)} → 较早证据 ${count(m.freshness_filtered_insight_count)} → 已发布去重 ${count(m.already_published_filtered_insight_count)} → 补充发现 ${count(m.supplemental_published_insight_count)}/${count(m.supplemental_candidate_count)} → 最终发布 ${count(m.published_insight_count)}（引用 ${count(m.published_citation_count)}）`;
}
export function ProvenanceTimeline({ traceId, showBriefFunnel = false }: { traceId: string; showBriefFunnel?: boolean }) {
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { fetch(`/api/generation-traces/${encodeURIComponent(traceId)}`, { cache: "no-store" })
    .then(async (res) => res.ok ? res.json() : Promise.reject()).then((data) => setTrace({ timeline: data.timeline ?? [], runtime: data.runtime })).catch(() => setError(true)); }, [traceId]);
  const funnel = showBriefFunnel && trace ? briefFunnelText(trace.timeline) : null;
  return <details className="audit"><summary>生成溯源 · Trace <code>{traceId}</code>（点击展开）</summary>
    {error ? <p className="muted">时间线暂不可用。</p> : trace === null ? <p className="muted">加载中…</p> : <>
      {trace.runtime ? <p className="muted">运行版本
        {trace.runtime.git_sha ? <> · Git <code>{trace.runtime.git_sha}</code></> : null}
        {trace.runtime.image_digest ? <> · 镜像 <code>{trace.runtime.image_digest}</code></> : null}
        {trace.runtime.provenance_schema_version ? <> · 溯源 schema <code>{trace.runtime.provenance_schema_version}</code></> : null}
      </p> : <p className="muted">运行版本未记录（legacy / partial）。</p>}
      {funnel ? <p className="muted">{funnel}</p> : null}
      <ol>{trace.timeline.map((event) => <li key={event.sequence}><code>{event.sequence}</code> · <strong>{event.stage}</strong> / {event.event_type}
        {event.reason_code ? <span className="muted"> · {REASON_LABEL[event.reason_code] ?? event.reason_code}</span> : null}
        {metricsText(event.metrics) ? <span className="muted"> · {metricsText(event.metrics)}</span> : null}
        {event.refs.length ? <span className="muted"> · {event.refs.map((ref) => `${ref.role}:${ref.type}@${ref.revision}`).join(", ")}</span> : null}
      </li>)}</ol>
    </>}
  </details>;
}
