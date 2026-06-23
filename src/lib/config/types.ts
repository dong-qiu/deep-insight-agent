/** 静态配置 schema（架构「配置分离」）。Source/Topic 配置形状与 types.ts 实体一致，可直接落库。 */
import { z } from "zod/v4";
import { isValidFacet } from "../topics/facets.js";

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
  // ADR-0010 分面标签——分类唯一维度（Step2c 砍 industry 后**必填 ≥1**）；配置层校词表 + 非空，与 validate.ts 同口径。
  facets: z.array(z.string()).refine((arr) => arr.length > 0 && arr.every(isValidFacet), {
    message: "facets 必填且须为受控 domain:<值>（至少一个）",
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
