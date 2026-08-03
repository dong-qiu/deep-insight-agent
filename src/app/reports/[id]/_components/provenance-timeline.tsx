"use client";
import { useEffect, useState } from "react";

interface TimelineEvent { sequence: number; stage: string; event_type: string; attempt: number; occurred_at: string; reason_code?: string; refs: Array<{ type: string; revision: string; role: string }> }
export function ProvenanceTimeline({ traceId }: { traceId: string }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { fetch(`/api/generation-traces/${encodeURIComponent(traceId)}`, { cache: "no-store" })
    .then(async (res) => res.ok ? res.json() : Promise.reject()).then((data) => setEvents(data.timeline ?? [])).catch(() => setError(true)); }, [traceId]);
  return <details className="audit"><summary>生成溯源 · Trace <code>{traceId}</code>（点击展开）</summary>
    {error ? <p className="muted">时间线暂不可用。</p> : events === null ? <p className="muted">加载中…</p> : <ol>
      {events.map((event) => <li key={event.sequence}><code>{event.sequence}</code> · <strong>{event.stage}</strong> / {event.event_type}
        {event.reason_code ? <span className="muted"> · {event.reason_code}</span> : null}
        {event.refs.length ? <span className="muted"> · {event.refs.map((ref) => `${ref.role}:${ref.type}@${ref.revision}`).join(", ")}</span> : null}
      </li>)}
    </ol>}
  </details>;
}
