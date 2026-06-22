/** 主题行为原型（archetype）注册表（ADR-0010 Step1）。
 *
 *  archetype = 命名的**行为策略预设**，topic 引用其 key；profile 的旋钮在**代码常量**（行为=代码/政策、
 *  非用户数据），加原型零迁移（reference-data 模式，不用 DB CHECK）。校验经 `ARCHETYPE_VALUES`（app 层）。
 *
 *  Step1 只落「相关性策略」一项旋钮（接 scheduler.ts:rankAndDiversify 的 relevanceFloor）：
 *   - deep_vertical：软策略——不设下限，保留 0 命中项 + 多样化兜底（护 arXiv 等措辞不同但相关的研究源）；
 *   - horizontal_pulse：硬下限——命中关键词 < floor 的项落选（砍纯噪声），floor 保护见 rankAndDiversify。
 *  注：硬下限只砍「完全不沾边」，治不了「沾边但离题」（需更细阈值，ADR-0010 留后续 1c）。 */
import type { Archetype } from "../types.js";

export const ARCHETYPE_VALUES = ["deep_vertical", "horizontal_pulse"] as const;

export interface ArchetypeProfile {
  /** 相关性硬下限：命中关键词 token 数 < 此值的候选落选。undefined = 软策略（不过滤）。 */
  relevanceFloor?: number;
}

export const ARCHETYPE_REGISTRY: Record<Archetype, ArchetypeProfile> = {
  deep_vertical: {}, // 软策略：无下限
  horizontal_pulse: { relevanceFloor: 1 }, // 硬：至少命中 1 个关键词 token
};

/** 是否合法 archetype（app 校验，validate.ts 用）。 */
export function isArchetype(a: unknown): a is Archetype {
  return typeof a === "string" && (ARCHETYPE_VALUES as readonly string[]).includes(a);
}

/** 取某 archetype 的 profile；未知值回退 deep_vertical（最保守、行为=现状）。 */
export function archetypeProfile(a: string | undefined): ArchetypeProfile {
  return (a && ARCHETYPE_REGISTRY[a as Archetype]) || ARCHETYPE_REGISTRY.deep_vertical;
}
