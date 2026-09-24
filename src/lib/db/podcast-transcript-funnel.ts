/** Read-only source/day funnel for transcript acquisition diagnostics.
 *
 * This projection deliberately consumes only TranscriptAcquisitionFact. It neither changes source
 * health nor participates in ContentItem eligibility, report selection, or citation validation.
 */
import type { DB } from "./index.js";
import type { TranscriptExecutionScope } from "../types.js";

export interface TranscriptAcquisitionFunnelInput {
  from: string;
  to: string;
  source_id?: string;
  execution_scope?: TranscriptExecutionScope;
}

export interface TranscriptAcquisitionReasonCount {
  outcome: string;
  reason_code: string | null;
  count: number;
}

export interface TranscriptAcquisitionFunnelRow {
  source_id: string;
  day: string;
  execution_scope: TranscriptExecutionScope;
  candidates: number;
  decision_fetch: number;
  decision_unknown: number;
  decision_hard_negative: number;
  attempts: number;
  terminals: number;
  successes: number;
  budget_limited: number;
  bytes: number;
  duration_ms: number;
  terminal_reasons: TranscriptAcquisitionReasonCount[];
}

type Aggregate = Omit<TranscriptAcquisitionFunnelRow, "terminal_reasons">;
type Reason = TranscriptAcquisitionReasonCount & Pick<TranscriptAcquisitionFunnelRow, "source_id" | "day" | "execution_scope">;

/** Bounded source/day read model. `bytes` and `duration_ms` are terminal observations so retries
 * remain visible; they are not a billable cost ledger. */
export function readTranscriptAcquisitionFunnel(
  db: DB,
  input: TranscriptAcquisitionFunnelInput,
): TranscriptAcquisitionFunnelRow[] {
  const where = ["occurred_at >= @from", "occurred_at < @to"];
  if (input.source_id) where.push("source_id = @source_id");
  if (input.execution_scope) where.push("execution_scope = @execution_scope");
  const predicate = where.join(" AND ");
  const params = {
    from: input.from, to: input.to,
    source_id: input.source_id ?? null, execution_scope: input.execution_scope ?? null,
  };
  const aggregates = db.prepare(`
    SELECT source_id, substr(occurred_at,1,10) AS day, execution_scope,
      SUM(CASE WHEN stage='candidate' THEN 1 ELSE 0 END) AS candidates,
      SUM(CASE WHEN stage='decision' AND decision='fetch' THEN 1 ELSE 0 END) AS decision_fetch,
      SUM(CASE WHEN stage='decision' AND decision='unknown' THEN 1 ELSE 0 END) AS decision_unknown,
      SUM(CASE WHEN stage='decision' AND decision='hard_negative' THEN 1 ELSE 0 END) AS decision_hard_negative,
      SUM(CASE WHEN stage='attempt' THEN 1 ELSE 0 END) AS attempts,
      SUM(CASE WHEN stage='terminal' THEN 1 ELSE 0 END) AS terminals,
      SUM(CASE WHEN stage='terminal' AND outcome='success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN stage='terminal' AND outcome='budget_limited' THEN 1 ELSE 0 END) AS budget_limited,
      COALESCE(SUM(CASE WHEN stage='terminal' THEN bytes ELSE 0 END),0) AS bytes,
      COALESCE(SUM(CASE WHEN stage='terminal' THEN duration_ms ELSE 0 END),0) AS duration_ms
    FROM transcript_acquisition_fact WHERE ${predicate}
    GROUP BY source_id, substr(occurred_at,1,10), execution_scope
    ORDER BY day DESC, source_id ASC, execution_scope ASC`).all(params) as Aggregate[];
  const reasons = db.prepare(`
    SELECT source_id, substr(occurred_at,1,10) AS day, execution_scope, outcome, reason_code, COUNT(*) AS count
    FROM transcript_acquisition_fact WHERE ${predicate} AND stage='terminal'
    GROUP BY source_id, substr(occurred_at,1,10), execution_scope, outcome, reason_code
    ORDER BY source_id ASC, day DESC, execution_scope ASC, count DESC, outcome ASC, reason_code ASC`).all(params) as Reason[];
  const grouped = new Map<string, TranscriptAcquisitionReasonCount[]>();
  for (const reason of reasons) {
    const key = `${reason.source_id}\u0000${reason.day}\u0000${reason.execution_scope}`;
    const list = grouped.get(key) ?? [];
    list.push({ outcome: reason.outcome, reason_code: reason.reason_code, count: Number(reason.count) });
    grouped.set(key, list);
  }
  return aggregates.map((row) => ({
    ...row,
    candidates: Number(row.candidates), decision_fetch: Number(row.decision_fetch), decision_unknown: Number(row.decision_unknown),
    decision_hard_negative: Number(row.decision_hard_negative), attempts: Number(row.attempts), terminals: Number(row.terminals),
    successes: Number(row.successes), budget_limited: Number(row.budget_limited), bytes: Number(row.bytes), duration_ms: Number(row.duration_ms),
    terminal_reasons: grouped.get(`${row.source_id}\u0000${row.day}\u0000${row.execution_scope}`) ?? [],
  }));
}
