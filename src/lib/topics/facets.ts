/** 分面标签（facets）受控词表（ADR-0010）——分类体系的唯一事实源（Step2c 起 industry 已彻底退役）。
 *
 *  facet = `<维度>:<值>` 字符串（如 `domain:software-engineering`），多值（一 topic 可多个、容跨域）。
 *  两个维度：
 *   - `domain`（学科域，**必填 ≥1**）：内容关于哪个技术学科——software-engineering / security / foundation-models。
 *   - `lens`（视角，**选填**，ADR-0010 后续）：用哪种眼光看——technical（实现/研究/攻防）/ business（市场/产业/资本）。
 *     未标 lens 视作 technical（缺省）。lens 把「产业视角」从 domain 解放出来（取代旧 domain:ai-industry 伪学科域）。
 *  词表落**代码常量**（同 archetype，加值零迁移、app 校验、不用 DB CHECK）。
 *  注：domain 值不带 `ai-` 前缀——「AI」是整个产品的恒定前提，编进每个域值即零区分度的噪声（ADR-0010 后续裁决）。 */

/** domain 维度的受控值（纯学科域，无 ai- 前缀）。加 domain 值 = 改本常量，零迁移。 */
export const DOMAIN_VALUES = ["software-engineering", "security", "foundation-models"] as const;
export type DomainValue = (typeof DOMAIN_VALUES)[number];

/** domain 值 → 人类可读标签（报告库筛选下拉 / 卡片展示用）。 */
export const DOMAIN_LABELS: Record<DomainValue, string> = {
  "software-engineering": "软件工程",
  "security": "安全",
  "foundation-models": "基础模型",
};

/** lens 维度的受控值（视角，选填）。technical 为缺省语义（未标 lens 即视作 technical）。 */
export const LENS_VALUES = ["technical", "business"] as const;
export type LensValue = (typeof LENS_VALUES)[number];

/** lens 值 → 人类可读标签。 */
export const LENS_LABELS: Record<LensValue, string> = {
  technical: "技术",
  business: "产业",
};

const DOMAIN_PREFIX = "domain:";
const LENS_PREFIX = "lens:";

/** 通用：facet 串 → 受控裸值（前缀匹配 + 白名单），不合法 → null。 */
function valueOf(facet: unknown, prefix: string, values: readonly string[]): string | null {
  if (typeof facet !== "string" || !facet.startsWith(prefix)) return null;
  const v = facet.slice(prefix.length);
  return values.includes(v) ? v : null;
}

/** 构造一个 domain facet 字符串：`domain:software-engineering`。 */
export function domainFacet(d: DomainValue): string {
  return `${DOMAIN_PREFIX}${d}`;
}

/** 构造一个 lens facet 字符串：`lens:business`。 */
export function lensFacet(l: LensValue): string {
  return `${LENS_PREFIX}${l}`;
}

/** 合法 facet？认 `domain:<受控值>` 或 `lens:<受控值>`（加维度时在此扩展）。 */
export function isValidFacet(f: unknown): f is string {
  return valueOf(f, DOMAIN_PREFIX, DOMAIN_VALUES) !== null || valueOf(f, LENS_PREFIX, LENS_VALUES) !== null;
}

/** 合法裸 domain 值？（如 "software-engineering"——校验 URL `?domain=` 参数白名单）。 */
export function isDomainValue(v: unknown): v is DomainValue {
  return typeof v === "string" && (DOMAIN_VALUES as readonly string[]).includes(v);
}

/** 合法裸 lens 值？（校验 URL `?lens=` 参数白名单）。 */
export function isLensValue(v: unknown): v is LensValue {
  return typeof v === "string" && (LENS_VALUES as readonly string[]).includes(v);
}

/** facet → 裸 domain 值（`domain:security` → `security`）；非合法 domain facet 返 null。 */
export function domainValueOf(facet: string): DomainValue | null {
  return valueOf(facet, DOMAIN_PREFIX, DOMAIN_VALUES) as DomainValue | null;
}

/** facet → 裸 lens 值（`lens:business` → `business`）；非合法 lens facet 返 null。 */
export function lensValueOf(facet: string): LensValue | null {
  return valueOf(facet, LENS_PREFIX, LENS_VALUES) as LensValue | null;
}

/** 该 facet 数组是否含 ≥1 个合法 domain facet（domain 必填校验用）。 */
export function hasDomainFacet(facets: readonly string[]): boolean {
  return facets.some((f) => domainValueOf(f) !== null);
}

/** facet → 人类标签（`domain:security` → "安全"、`lens:business` → "产业"）；未知/非受控 facet 回退原串。 */
export function facetLabel(facet: string): string {
  const d = domainValueOf(facet);
  if (d) return DOMAIN_LABELS[d];
  const l = lensValueOf(facet);
  if (l) return LENS_LABELS[l];
  return facet;
}

/** 解析 JSON facets 列；空/坏 JSON → `[]`（Step2c：industry 派生锚已退役，facets 处处显式、migrate 已回填）。
 *  topic / report_index 两处读列共用——单一实现，避免口径漂移。 */
export function parseFacets(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    /* 坏 JSON → 空 */
  }
  return [];
}
