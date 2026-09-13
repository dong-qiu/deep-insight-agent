/** 静态配置 schema（架构「配置分离」）。Source/Topic 配置形状与 types.ts 实体一致，可直接落库。 */
import { z } from "zod/v4";
import { hasDomainFacet, isValidFacet } from "../topics/facets.js";

export const SourceConfigSchema = z.object({
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
  transcript_strategy: z.enum(["all", "relevant_only"]).default("relevant_only"),
  transcript_max_items_per_run: z.number().int().positive().default(5),
  transcript_max_bytes_per_run: z.number().int().positive().default(5 * 1024 * 1024),
  transcript_timeout_budget_ms: z.number().int().positive().default(30_000),
  transcript_host_qps: z.number().positive().default(0.5),
  transcript_policy_version: z.string().trim().min(1).nullable().default(null),
}).superRefine((source, ctx) => {
  if (source.transcript_mode !== "off" && !source.transcript_policy_version) {
    ctx.addIssue({
      code: "custom",
      path: ["transcript_policy_version"],
      message: "observe/enabled transcript_mode 必须提供非空 transcript_policy_version",
    });
  }
});

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
