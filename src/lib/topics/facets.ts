/** 分面标签（facets）受控词表（ADR-0010 Step2a，取代刚性单值 industry）。
 *
 *  facet = `<维度>:<值>` 字符串（如 `domain:ai-swe`），多值（一 topic 可多个、容跨域）。首个维度 = `domain`。
 *  词表落**代码常量**（同 archetype，加值零迁移、app 校验、不用 DB CHECK）。
 *
 *  Step2a 落「字段 + 词表 + 从 industry 派生」（行为中性，industry 仍驱动一切）；
 *  Step2b 把 report 库筛选/展示从 industry 迁到 facets/domain（本文件加标签 + 解析/取值辅助）。 */
import type { Industry } from "../types.js";

/** domain 维度的受控值。前两个对齐 industry slug（派生用）；ai-industry 是给横向「产业」主题的新值
 *  （industry 枚举塞不下、正是 ADR-0010 立项之因）。加 domain 值 = 改本常量，零迁移。 */
export const DOMAIN_VALUES = ["ai-swe", "ai-security", "ai-industry"] as const;
export type DomainValue = (typeof DOMAIN_VALUES)[number];

/** domain 值 → 人类可读标签（报告库筛选下拉 / 卡片展示用）。 */
export const DOMAIN_LABELS: Record<DomainValue, string> = {
  "ai-swe": "AI 软件工程",
  "ai-security": "AI 安全",
  "ai-industry": "AI 产业动态",
};

/** domain facet 前缀。 */
const DOMAIN_PREFIX = "domain:";

/** 构造一个 domain facet 字符串：`domain:ai-swe`。 */
export function domainFacet(d: DomainValue): string {
  return `${DOMAIN_PREFIX}${d}`;
}

/** 合法 facet？目前只认 `domain:<受控值>`（未来加维度时在此扩展）。 */
export function isValidFacet(f: unknown): f is string {
  if (typeof f !== "string" || !f.startsWith(DOMAIN_PREFIX)) return false;
  return (DOMAIN_VALUES as readonly string[]).includes(f.slice(DOMAIN_PREFIX.length));
}

/** 合法裸 domain 值？（如 "ai-swe"——校验 URL `?domain=` 参数白名单）。 */
export function isDomainValue(v: unknown): v is DomainValue {
  return typeof v === "string" && (DOMAIN_VALUES as readonly string[]).includes(v);
}

/** facet → 裸 domain 值（`domain:ai-swe` → `ai-swe`）；非合法 domain facet 返 null。 */
export function domainValueOf(facet: string): DomainValue | null {
  return isValidFacet(facet) ? (facet.slice(DOMAIN_PREFIX.length) as DomainValue) : null;
}

/** facet → 人类标签（`domain:ai-swe` → "AI 软件工程"）；未知或非 domain facet 回退原串。 */
export function facetLabel(facet: string): string {
  const v = domainValueOf(facet);
  return v ? DOMAIN_LABELS[v] : facet;
}

/** 从 industry 派生默认 facets（兜底：存量主题/报告、未显式标 facets 时用，零回填）。
 *  industry slug 与 domain 值对齐 → `domain:<industry>`。 */
export function deriveFacetsFromIndustry(industry: Industry): string[] {
  return [domainFacet(industry)];
}

/** 解析 JSON facets 列；空/坏 JSON → 从 industry 派生（派生即正确、零回填）。
 *  topic / report_index 两处读列共用——单一实现，避免口径漂移。 */
export function parseFacetsOrDerive(raw: unknown, industry: Industry): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
  } catch {
    /* 坏 JSON → 落到派生 */
  }
  return deriveFacetsFromIndustry(industry);
}
