/** Run 列表的按 kind 聚合（admin 看板用）：纯函数，零依赖、可单测。
 *  对零成本 Run（ingest/report-gen 不调 LLM）统一返回 0，使表头总和与逐条一致。 */
import type { Run } from "../types.js";

export interface KindStats {
  kind: Run["kind"];
  total: number;
  done: number;
  failed: number;
  running: number;
  costUSD: number;
  avgDurationMs: number; // 仅在 done/failed 上算（运行中无 duration）
}

export function aggregateByKind(runs: Run[]): KindStats[] {
  const by = new Map<Run["kind"], KindStats>();
  for (const r of runs) {
    const s = by.get(r.kind) ?? { kind: r.kind, total: 0, done: 0, failed: 0, running: 0, costUSD: 0, avgDurationMs: 0 };
    s.total += 1;
    s[r.status] += 1;
    s.costUSD += r.cost?.amount ?? 0;
    by.set(r.kind, s);
  }
  // 第二次扫一遍算 avgDurationMs（done+failed 才有 duration）
  const durTotals = new Map<Run["kind"], { sum: number; n: number }>();
  for (const r of runs) {
    if (r.duration_ms == null) continue;
    const d = durTotals.get(r.kind) ?? { sum: 0, n: 0 };
    d.sum += r.duration_ms; d.n += 1;
    durTotals.set(r.kind, d);
  }
  for (const [kind, s] of by) {
    const d = durTotals.get(kind);
    s.avgDurationMs = d && d.n > 0 ? Math.round(d.sum / d.n) : 0;
  }
  // 固定 kind 顺序（管线流水方向，看板更易扫读）
  const order: Run["kind"][] = ["ingest", "analyze", "validate", "report-gen"];
  return order.map((k) => by.get(k)).filter((s): s is KindStats => !!s);
}
