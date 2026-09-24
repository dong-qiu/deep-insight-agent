/** 静态配置 schema（架构「配置分离」）。Source/Topic 配置形状与 types.ts 实体一致，可直接落库。 */
import { z } from "zod/v4";
import { hasDomainFacet, isValidFacet } from "../topics/facets.js";

const SourceConfigInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["rss", "arxiv", "api"]),
  endpoint: z.string(),
  topic_ids: z.array(z.string()),
  fetch_interval: z.string(),
  backfill: z.object({ depth: z.string(), max_cost: z.number() }).nullable().default(null),
  enabled: z.boolean().default(true),
  // ADR-0008 决定③ 按源全文策略（yaml 不填则默认 feed / 无容器覆盖）
  fetch_mode: z.enum(["feed", "full_text"]).default("feed"),
  content_container: z.string().nullable().default(null),
  // ADR-0027：新源先关闭全文，只有逐源经过 shadow/eval 后才允许 enabled。
  transcript_mode: z.enum(["off", "observe", "enabled"]).default("off"),
  // `off` remains backward-compatible with omitted policy fields. Once a source opts into a
  // policy-aware mode, however, every decision and resource limit must be authored explicitly:
  // silently inheriting a default would make an approval impossible to audit or reproduce.
  transcript_strategy: z.enum(["all", "relevant_only"]).optional(),
  transcript_max_items_per_run: z.number().int().positive().optional(),
  transcript_max_bytes_per_run: z.number().int().positive().optional(),
  transcript_timeout_budget_ms: z.number().int().positive().optional(),
  transcript_host_qps: z.number().positive().optional(),
  transcript_policy_version: z.string().trim().min(1).nullable().default(null),
});

/** A source that is not yet policy-aware may use the legacy defaults. `observe` and `enabled`
 * cannot: their complete policy is the unit that is reviewed, versioned and later approved. */
export const SourceConfigSchema = SourceConfigInputSchema.superRefine((source, ctx) => {
  if (source.transcript_mode === "off") return;
  if (!source.transcript_policy_version) {
    ctx.addIssue({
      code: "custom",
      path: ["transcript_policy_version"],
      message: "observe/enabled transcript_mode 必须提供非空 transcript_policy_version",
    });
  }
  for (const field of [
    "transcript_strategy",
    "transcript_max_items_per_run",
    "transcript_max_bytes_per_run",
    "transcript_timeout_budget_ms",
    "transcript_host_qps",
  ] as const) {
    if (source[field] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: "observe/enabled transcript_mode 必须显式提供完整的策略与资源上限",
      });
    }
  }
}).transform((source) => ({
    ...source,
    // `off` retains any source-authored future policy as inert configuration, while only a
    // non-off source may actually consume it (the runtime guard enforces that boundary).
    transcript_strategy: source.transcript_strategy ?? "relevant_only",
    transcript_max_items_per_run: source.transcript_max_items_per_run ?? 5,
    transcript_max_bytes_per_run: source.transcript_max_bytes_per_run ?? 5 * 1024 * 1024,
    transcript_timeout_budget_ms: source.transcript_timeout_budget_ms ?? 30_000,
    transcript_host_qps: source.transcript_host_qps ?? 0.5,
}));

export const TopicConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  language: z.enum(["zh", "en", "mixed"]),
  brief_schedule: z.enum(["daily", "weekly"]),
  enabled: z.boolean().default(true),
  // ADR-0010 行为原型；缺省 deep_vertical（= 现状行为），defaults.yaml 可显式标 horizontal_pulse。
  archetype: z.enum(["deep_vertical", "horizontal_pulse"]).default("deep_vertical"),
  // ADR-0010 分面标签：每项受控 facet（domain:<值> 或 lens:<值>），且至少含 1 个 domain（lens 选填）；与 validate.ts 同口径。
  facets: z.array(z.string()).refine((arr) => arr.every(isValidFacet) && hasDomainFacet(arr), {
    message: "facets 每项须为受控 domain:/lens: 值，且至少含一个 domain",
  }),
});

/** 配置中不依赖模型凭据、可安全用于离线 source 工具的部分。
 *
 * 不能以此替代完整应用配置：应用启动仍必须经 AppConfigSchema 验证 models.apiKey。
 */
export const StaticSourceConfigSchema = z.object({
  defaultTopics: z.array(TopicConfigSchema),
  defaultSources: z.array(SourceConfigSchema),
});

export const AppConfigSchema = z.object({
  models: z.object({
    analyzer: z.string(),
    validator: z.string(),
    apiKey: z.string(),
    baseUrl: z.string().optional(),
  }),
  rateLimit: z.object({ perAccountPerMin: z.number(), perIpPerMin: z.number() }),
  system: z.object({ ingestConcurrency: z.number(), reportP50TargetMin: z.number() }),
  defaultTopics: z.array(TopicConfigSchema),
  defaultSources: z.array(SourceConfigSchema),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type StaticSourceConfig = z.infer<typeof StaticSourceConfigSchema>;
