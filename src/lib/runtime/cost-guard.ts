/** 成本预算守卫 —— 触顶熔断 / 告警的判定核心（architecture「成本控制实现路径 · 配额校验 + 熔断」）。
 *
 *  配置走 env（单用户 MVP；多账号 / per-topic 配额推后，见 docs/develop/decisions.md）：
 *    COST_LIMIT_DAILY   日上限（USD），未设 / 非正数 = 该维度不限
 *    COST_LIMIT_MONTHLY 月上限（USD，自然月 UTC），未设 / 非正数 = 该维度不限
 *    COST_ALERT_PCT     告警阈值百分比（默认 80；落在 (0,100]，脏值回落 80）
 *
 *  已花额取自 run.cost.amount（每段管线落库的真实成本，USD，与 cost.amount 单位一致）。
 *  判定为纯函数（evaluateBudget）便于单测；getBudgetStatus 查库后委托给它。
 *  两条路径共用本判定，差别只在拿到 verdict 后做什么：
 *    - 自动管线（scheduler/cron）：exceeded → 硬熔断跳过剩余 topic；
 *    - 手动操作（深挖 / 追问）：exceeded → 放行但提示（不拦，见 decisions）。 */
import type { DB } from "../db/index.js";
import { sumRunCostSince } from "../db/repos.js";

export interface BudgetLimits {
  daily?: number; // USD；undefined = 不限
  monthly?: number; // USD；undefined = 不限
  alertPct: number; // (0,100]
}

export type BudgetVerdict = "ok" | "alert" | "exceeded";

export interface BudgetStatus {
  spentToday: number;
  spentMonth: number;
  daily?: number;
  monthly?: number;
  dailyRatio?: number; // spentToday / daily（无 daily 时 undefined）
  monthlyRatio?: number; // spentMonth / monthly（无 monthly 时 undefined）
  alertPct: number; // 生效的告警阈值（透传供看板进度条着色等，与判定口径一致）
  verdict: BudgetVerdict;
  /** 人类可读原因（alert / exceeded 时给出，供告警 / 日志 / 看板复用） */
  reason?: string;
}

/** 解析正数 env：缺失 / NaN / ≤0 → undefined（视为该维度不限）。 */
function parsePositive(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 从 env 读限额。alertPct 须落 (0,100]，脏值回落默认 80。 */
export function loadBudgetLimits(env: Record<string, string | undefined> = process.env): BudgetLimits {
  const pct = Number(env.COST_ALERT_PCT);
  return {
    daily: parsePositive(env.COST_LIMIT_DAILY),
    monthly: parsePositive(env.COST_LIMIT_MONTHLY),
    alertPct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : 80,
  };
}

/** 纯判定：给定两窗已花额 + 限额 → 状态。任一维度触顶 = exceeded；任一维度 ≥alertPct = alert；
 *  无任何限额（daily/monthly 皆 undefined）→ 恒 ok（零回归：未配预算 = 行为与改动前一致）。 */
export function evaluateBudget(
  sums: { today: number; month: number },
  limits: BudgetLimits,
): BudgetStatus {
  const spentToday = sums.today;
  const spentMonth = sums.month;
  const fmt = (n: number): string => `$${n.toFixed(2)}`;
  const reasons: string[] = [];
  let verdict: BudgetVerdict = "ok";

  const consider = (label: string, spent: number, limit: number | undefined): void => {
    if (limit == null) return;
    if (spent >= limit) {
      verdict = "exceeded";
      reasons.push(`${label}预算已触顶（${fmt(spent)} / ${fmt(limit)}）`);
    } else if (spent * 100 >= limit * limits.alertPct) {
      if (verdict !== "exceeded") verdict = "alert"; // exceeded 优先级高于 alert，不被覆盖
      reasons.push(`${label}预算已用 ${Math.round((spent / limit) * 100)}%（${fmt(spent)} / ${fmt(limit)}）`);
    }
  };
  consider("日", spentToday, limits.daily);
  consider("月", spentMonth, limits.monthly);

  return {
    spentToday,
    spentMonth,
    daily: limits.daily,
    monthly: limits.monthly,
    dailyRatio: limits.daily != null ? spentToday / limits.daily : undefined,
    monthlyRatio: limits.monthly != null ? spentMonth / limits.monthly : undefined,
    alertPct: limits.alertPct,
    verdict,
    reason: reasons.length ? reasons.join("；") : undefined,
  };
}

/** UTC 当日 00:00 的 ISO（日窗起点）。started_at 同为 ISO8601，字典序比较即时间序。 */
function startOfUtcDay(nowIso: string): string {
  return `${nowIso.slice(0, 10)}T00:00:00.000Z`;
}
/** UTC 当月 1 号 00:00 的 ISO（自然月窗起点，对齐账单直觉）。 */
function startOfUtcMonth(nowIso: string): string {
  return `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;
}

/** 查库 + 判定：从 run 表累计今日 / 本月真实成本，按 env 限额给出预算状态。
 *  nowIso 注入便于测试（默认进程当前 UTC 时间）。 */
export function getBudgetStatus(db: DB, opts: { nowIso?: string } = {}): BudgetStatus {
  const limits = loadBudgetLimits();
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = sumRunCostSince(db, startOfUtcDay(nowIso));
  const month = sumRunCostSince(db, startOfUtcMonth(nowIso));
  return evaluateBudget({ today, month }, limits);
}
