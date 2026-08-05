"use client";
import { useEffect, useState } from "react";

interface TimelineEvent { sequence: number; stage: string; event_type: string; attempt: number; occurred_at: string; reason_code?: string; metrics?: Record<string, number>; refs: Array<{ type: string; revision: string; role: string }> }
const COUNT_LABEL: Record<string, string> = {
  input_content_count: "分析输入", analysis_insight_count: "产出洞察", no_significant_event: "无重要事件",
  citation_total: "校验引用", citation_pass: "通过", citation_blocked: "拦截", citation_flagged: "存疑", citation_errored: "错误",
  includable_insight_count: "可纳入洞察", releasable: "可发布", freshness_filtered_insight_count: "新鲜度过滤",
  already_published_filtered_insight_count: "已发布去重", published_insight_count: "发布洞察", published_citation_count: "发布引用",
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
export function ProvenanceTimeline({ traceId }: { traceId: string }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { fetch(`/api/generation-traces/${encodeURIComponent(traceId)}`, { cache: "no-store" })
    .then(async (res) => res.ok ? res.json() : Promise.reject()).then((data) => setEvents(data.timeline ?? [])).catch(() => setError(true)); }, [traceId]);
  return <details className="audit"><summary>生成溯源 · Trace <code>{traceId}</code>（点击展开）</summary>
    {error ? <p className="muted">时间线暂不可用。</p> : events === null ? <p className="muted">加载中…</p> : <ol>
      {events.map((event) => <li key={event.sequence}><code>{event.sequence}</code> · <strong>{event.stage}</strong> / {event.event_type}
        {event.reason_code ? <span className="muted"> · {REASON_LABEL[event.reason_code] ?? event.reason_code}</span> : null}
        {metricsText(event.metrics) ? <span className="muted"> · {metricsText(event.metrics)}</span> : null}
        {event.refs.length ? <span className="muted"> · {event.refs.map((ref) => `${ref.role}:${ref.type}@${ref.revision}`).join(", ")}</span> : null}
      </li>)}
    </ol>}
  </details>;
}
