/** 从 PPT 导出 API 响应头解析 polish 元数据（C/D 阶段）。
 *  抽成纯函数便于 vitest 覆盖：组件层只做 fetch + 渲染、不参与解析逻辑。
 *
 *  header 契约（src/app/api/reports/[id]/pptx/route.ts）：
 *  - X-Ppt-Polish-Cache: "none"|"hit"|"miss"
 *  - X-Ppt-Polish-Status: "none"|"complete"|"no-executive"|"partial"
 *  - X-Ppt-Polish-Coverage: "N/M exec=y|n"
 *  - X-Ppt-Polish-Cost-Usd: 浮点字符串（fixed 6 位）
 *
 *  null 表示该值缺失或解析失败——UI 走 fallback、不报错。 */

export type PolishCache = "none" | "hit" | "miss";
export type PolishStatus = "none" | "complete" | "no-executive" | "partial";

export interface PolishMeta {
  cache: PolishCache;
  status: PolishStatus;
  coverage: { perInsightDone: number; perInsightTotal: number; hasExecutive: boolean } | null;
  costUsd: number;
}

const CACHE_VALUES: ReadonlySet<string> = new Set(["none", "hit", "miss"]);
const STATUS_VALUES: ReadonlySet<string> = new Set(["none", "complete", "no-executive", "partial"]);

function parseCoverage(raw: string | null): PolishMeta["coverage"] {
  if (!raw) return null;
  // 形如 "12/13 exec=n" 或 "0/0 exec=n"；任何不匹配都返 null（UI 走 fallback）
  const m = raw.match(/^(\d+)\/(\d+)\s+exec=([yn])$/);
  if (!m) return null;
  return {
    perInsightDone: Number(m[1]),
    perInsightTotal: Number(m[2]),
    hasExecutive: m[3] === "y",
  };
}

export function parsePolishMeta(headers: Headers): PolishMeta | null {
  const cache = headers.get("X-Ppt-Polish-Cache");
  const status = headers.get("X-Ppt-Polish-Status");
  // 未启用 polish 的请求（A 路径）整组 header 都没有/都是 none——也返 null，UI 不显状态行
  if (!cache || !CACHE_VALUES.has(cache)) return null;
  if (!status || !STATUS_VALUES.has(status)) return null;
  if (status === "none") return null;
  const cost = Number(headers.get("X-Ppt-Polish-Cost-Usd"));
  return {
    cache: cache as PolishCache,
    status: status as PolishStatus,
    coverage: parseCoverage(headers.get("X-Ppt-Polish-Coverage")),
    costUsd: Number.isFinite(cost) ? cost : 0,
  };
}

/** 渲染状态行文案（纯函数，可单测）。返 null 表示不显示状态行。 */
export function describePolishMeta(meta: PolishMeta | null): string | null {
  if (!meta) return null;
  const cacheLabel = meta.cache === "hit" ? "缓存命中" : "本次跑了 LLM";
  const cov = meta.coverage
    ? `${meta.coverage.perInsightDone}/${meta.coverage.perInsightTotal} 重点 · ${meta.coverage.hasExecutive ? "含 Executive 页" : "无 Executive 页"}`
    : "";
  const cost = meta.costUsd > 0 ? ` · 本次 $${meta.costUsd.toFixed(4)}` : "";
  return `${cacheLabel} · ${cov}${cost}`;
}

/** 是否值得"重新生成"补漏（status 不是 complete 时才显示链接）。 */
export function shouldOfferRefresh(meta: PolishMeta | null): boolean {
  if (!meta) return false;
  return meta.status === "partial" || meta.status === "no-executive";
}
