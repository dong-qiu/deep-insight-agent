/** Run 列表的按 kind 聚合（admin 看板用）：纯函数，零依赖、可单测。
 *  对零成本 Run（ingest/report-gen 不调 LLM）统一返回 0，使表头总和与逐条一致。 */
import type { Run, Source } from "../types.js";

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

export interface DailyCost {
  date: string;   // yyyy-mm-dd
  costUSD: number;
  runCount: number;
}

/** 按天聚合最近 N 天的成本（B-5 admin 时序图）：
 *  - 缺失日补 0（保持 X 轴连续）；
 *  - date 取 started_at 的日期段（UTC，与 generated_at 一致）；
 *  - todayIso 注入便于测试。 */
export function aggregateDailyCost(
  runs: Run[],
  opts: { days?: number; todayIso?: string } = {},
): DailyCost[] {
  const days = opts.days ?? 30;
  const todayIso = opts.todayIso ?? new Date().toISOString();
  const today = todayIso.slice(0, 10);
  // 生成最近 days 天的日期序列（从早到晚），保证 X 轴连续
  const dates: string[] = [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(todayMs - i * 86400_000).toISOString().slice(0, 10));
  }
  const byDate = new Map<string, DailyCost>(
    dates.map((d) => [d, { date: d, costUSD: 0, runCount: 0 }]),
  );
  for (const r of runs) {
    const d = r.started_at.slice(0, 10);
    const slot = byDate.get(d);
    if (!slot) continue; // 超出 N 天窗口
    slot.costUSD += r.cost?.amount ?? 0;
    slot.runCount += 1;
  }
  return dates.map((d) => byDate.get(d)!);
}

/** 管线轮次分组（admin 看板可理解性）：把一串 Run 按 started_at 的时间间隔聚成"轮次"——
 *  一次 cron 触发的 采集→分析→校验→生成 各 Run 在分钟级窗口内扎堆，轮次间隔小时/天级。
 *  纯函数、可测。gapMs（默认 2h）= 超过该间隔即视为新一轮（日度 cron 轮清晰分开，手动深挖自成一轮）。 */
export interface RunRound {
  start: string; // 本轮最早 started_at
  end: string;   // 本轮最晚
  runs: Run[];   // 倒序（最新在前）
  counts: Record<Run["kind"], number>;
  failed: number;
  costUSD: number;
}

export function groupRunsIntoRounds(runs: Run[], gapMs = 2 * 3_600_000): RunRound[] {
  const sorted = [...runs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)); // desc
  const rounds: RunRound[] = [];
  for (const r of sorted) {
    const last = rounds[rounds.length - 1];
    // desc 遍历：r 比 last 更早，间隔 = last.start - r.started_at
    if (last && Date.parse(last.start) - Date.parse(r.started_at) <= gapMs) {
      last.runs.push(r);
      last.start = r.started_at; // r 更早 → 更新本轮最早
      last.counts[r.kind] += 1;
      last.failed += r.status === "failed" ? 1 : 0;
      last.costUSD += r.cost?.amount ?? 0;
    } else {
      rounds.push({
        start: r.started_at, end: r.started_at, runs: [r],
        counts: { ingest: 0, analyze: 0, validate: 0, "report-gen": 0, [r.kind]: 1 } as Record<Run["kind"], number>,
        failed: r.status === "failed" ? 1 : 0,
        costUSD: r.cost?.amount ?? 0,
      });
    }
  }
  return rounds;
}

/** 数据源健康（admin 看板 · spec line 304）：每个源的采集成功率 / 最近成功 / 近期错误 / 连续失败。
 *  纯函数，可单测。spine = 传入的 sources（通常 listSources 全量）；用 ingest Run 叠加健康，
 *  无 run 的源仍列出（total=0 = "从未采集"，本身是信号）。runs 期望仅 kind='ingest'（调用方过滤）。 */
export interface SourceHealth {
  source_id: string;
  name: string;
  type: Source["type"] | null;
  enabled: boolean;
  total: number;
  ok: number;
  failed: number;
  successRate: number;       // ok/total（total=0 时为 0）
  lastSuccessAt: string | null;
  lastError: { at: string; type: string; message: string } | null;
  consecutiveFails: number;  // 最近一次成功之后的连续失败数（按时间倒序累计）
}

export function aggregateSourceHealth(ingestRuns: Run[], sources: Source[]): SourceHealth[] {
  // 每源按 started_at 倒序的 run 列表（用于 last*/连续失败判定）
  const bySource = new Map<string, Run[]>();
  for (const r of ingestRuns) {
    const sid = r.target.source_id;
    if (!sid) continue;
    (bySource.get(sid) ?? bySource.set(sid, []).get(sid)!).push(r);
  }
  for (const list of bySource.values()) list.sort((a, b) => (a.started_at < b.started_at ? 1 : -1)); // desc

  const health = (sid: string, name: string, type: Source["type"] | null, enabled: boolean): SourceHealth => {
    const list = bySource.get(sid) ?? [];
    const ok = list.filter((r) => r.status === "done").length;
    const failed = list.filter((r) => r.status === "failed").length;
    const lastSuccess = list.find((r) => r.status === "done");
    const lastFail = list.find((r) => r.status === "failed");
    let consecutiveFails = 0;
    for (const r of list) { // 倒序：从最近开始累计失败，遇到 done/running 停
      if (r.status === "failed") consecutiveFails += 1;
      else break;
    }
    return {
      source_id: sid, name, type, enabled,
      total: list.length, ok, failed,
      successRate: list.length ? ok / list.length : 0,
      lastSuccessAt: lastSuccess?.ended_at ?? lastSuccess?.started_at ?? null, // ended_at 缺失（瞬态）退 started_at，与 lastError.at 口径一致
      lastError: lastFail?.error ? { at: lastFail.ended_at ?? lastFail.started_at, type: lastFail.error.type, message: lastFail.error.message } : null,
      consecutiveFails,
    };
  };

  const known = new Set(sources.map((s) => s.id));
  const rows: SourceHealth[] = sources.map((s) => health(s.id, s.name, s.type, s.enabled));
  // run 里引用但 sources 已删的源——仍列出（"未知源"），避免健康面板漏掉历史失败
  for (const sid of bySource.keys()) {
    if (!known.has(sid)) rows.push(health(sid, sid, null, false));
  }
  // 排序：需关注的在前——连续失败多 > 成功率低 > 名称
  return rows.sort(
    (a, b) =>
      b.consecutiveFails - a.consecutiveFails ||
      a.successRate - b.successRate ||
      a.name.localeCompare(b.name),
  );
}

// ── 源健康自愈：熔断判定（ADR-0008 决定② / 切片3b）──

export interface CircuitConfig {
  fails: number; // 连续失败下限（默认 5，env SOURCE_CIRCUIT_FAILS）——须 > 抖动源单日抖动量
  days: number; // 距最近成功天数下限（默认 3，env SOURCE_CIRCUIT_DAYS）——时间为主、计数防抖（评审）
}
export function circuitConfig(): CircuitConfig {
  return {
    fails: Number(process.env.SOURCE_CIRCUIT_FAILS) || 5,
    days: Number(process.env.SOURCE_CIRCUIT_DAYS) || 3,
  };
}

export interface CircuitEval {
  open: boolean; // 是否该熔断
  consecutiveFails: number; // 锚定后的连续失败数（供告警/审计）
  lastErrorMsg: string | null;
}

/** 判某源是否该系统熔断（双条件 + circuit_reset_at 锚定 + 排除 probe run）。纯函数、可单测。
 *  - 只对 `enabled 且未熔断` 的源判 open（不重复熔断、不碰人工停用）。
 *  - **只统计 circuit_reset_at 之后的 ingest run**（防复活/人工 re-enable 后旧失败立刻反扑——评审🔴）。
 *  - 排除半开探测 run（target.probe，3b-2；现无 probe run，前向兼容）。
 *  - 熔断 = 连续失败 >= fails **且** 距最近成功（无则距锚点/最早失败）> days 天（时间为主、计数防抖）。 */
export function evaluateCircuit(
  ingestRunsForSource: Run[],
  source: Source,
  now: number,
  cfg: CircuitConfig = circuitConfig(),
): CircuitEval {
  const reset = source.circuit_reset_at ? Date.parse(source.circuit_reset_at) : 0;
  const runs = ingestRunsForSource
    .filter((r) => !(r.target as { probe?: boolean }).probe && Date.parse(r.started_at) > reset)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)); // desc
  let consecutiveFails = 0;
  for (const r of runs) {
    if (r.status === "failed") consecutiveFails += 1;
    else break; // 遇 done/running 停
  }
  const lastErrorMsg = runs.find((r) => r.status === "failed")?.error?.message ?? null;
  if (!source.enabled || source.disabled_reason === "circuit_open" || consecutiveFails < cfg.fails) {
    return { open: false, consecutiveFails, lastErrorMsg };
  }
  const lastSuccess = runs.find((r) => r.status === "done");
  const refMs = lastSuccess
    ? Date.parse(lastSuccess.ended_at ?? lastSuccess.started_at)
    : reset || (runs.length ? Date.parse(runs[runs.length - 1].started_at) : now); // 无成功 → 锚点 / 最早失败
  return { open: now - refMs > cfg.days * 86_400_000, consecutiveFails, lastErrorMsg };
}

// ── 零产出看门狗（治静默失败 · 切片3b-3）──
// 「采集成功但 inserted=0」= feed 变标题党 / 解析返 [] / WAF 软封 → 成功率显示 100% 实则 0 产出，
// 被健康面板掩盖（体检里 guid bug、相对 URL 丢条目都属此类）。判据须带**产出基线**降假阳：
// 仅「历史有过非零产出的源，突然连续 N 次 done 但 inserted=0」才报——避免生来稀疏源（owasp 3 条）误报。

export interface ZeroYieldEval {
  consecutiveZero: number; // 最近连续「done 且 inserted=0」的轮数
  hasBaseline: boolean; // 历史是否有过 inserted>0（曾稳定产出）
  alert: boolean; // 刚跨过阈值（== rounds）且有基线 → 报一次
}

/** 判某源是否触发零产出告警。纯函数。排除 probe run；inserted=null（旧 run/失败）打断连零计数（NULL=未知）。
 *  alert 仅在「恰好连续 N 次」那一刻为 true（边沿触发、天然去重，不每轮重复报）。 */
export function evaluateZeroYield(ingestRunsForSource: Run[], rounds: number): ZeroYieldEval {
  const runs = ingestRunsForSource
    .filter((r) => !(r.target as { probe?: boolean }).probe)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0)); // desc，相等返 0（稳定）
  // 注：「轮」= 一次 ingest run（含手动 /collect、/retry），非自然日——inserted 是**新增**条数（updated 不算）。
  let consecutiveZero = 0;
  for (const r of runs) {
    if (r.status === "done" && r.inserted === 0) consecutiveZero += 1;
    else break; // 失败 / running / inserted>0 / inserted=null 都打断
  }
  const hasBaseline = runs.some((r) => r.inserted != null && r.inserted > 0);
  return { consecutiveZero, hasBaseline, alert: hasBaseline && consecutiveZero === rounds };
}
