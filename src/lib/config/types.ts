/** 静态配置 schema（架构「配置分离」）。Source/Topic 配置形状与 types.ts 实体一致，可直接落库。 */
import { z } from "zod/v4";

export const SourceConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["rss", "arxiv", "api"]),
  endpoint: z.string(),
  industry: z.enum(["ai-swe", "ai-security"]),
  topic_ids: z.array(z.string()),
  fetch_interval: z.string(),
  backfill: z.object({ depth: z.string(), max_cost: z.number() }).nullable().default(null),
  enabled: z.boolean().default(true),
});

export const TopicConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  industry: z.enum(["ai-swe", "ai-security"]),
  language: z.enum(["zh", "en", "mixed"]),
  brief_schedule: z.enum(["daily", "weekly"]),
  enabled: z.boolean().default(true),
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
