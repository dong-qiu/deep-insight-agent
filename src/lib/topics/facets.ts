/** 分面标签（facets）受控词表（ADR-0010 Step2a，取代刚性单值 industry）。
 *
 *  facet = `<维度>:<值>` 字符串（如 `domain:ai-swe`），多值（一 topic 可多个、容跨域）。首个维度 = `domain`。
 *  词表落**代码常量**（同 archetype，加值零迁移、app 校验、不用 DB CHECK）。
 *
 *  Step2a 只落「字段 + 词表 + 从 industry 派生」（行为中性，industry 仍驱动一切）；
 *  Step2b 才把 report 库筛选/展示从 industry 迁到 facets、退役 industry。 */
import type { Industry } from "../types.js";

/** domain 维度的受控值。前两个对齐 industry slug（派生用）；ai-industry 是给横向「产业」主题的新值
 *  （industry 枚举塞不下、正是 ADR-0010 立项之因）。加 domain 值 = 改本常量，零迁移。 */
export const DOMAIN_VALUES = ["ai-swe", "ai-security", "ai-industry"] as const;
export type DomainValue = (typeof DOMAIN_VALUES)[number];

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

/** 从 industry 派生默认 facets（Step2a 兜底：存量主题/未显式标 facets 时用，零回填）。
 *  industry slug 与 domain 值对齐 → `domain:<industry>`。 */
export function deriveFacetsFromIndustry(industry: Industry): string[] {
  return [domainFacet(industry)];
}
