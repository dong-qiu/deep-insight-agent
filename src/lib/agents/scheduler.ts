/** 定时管线编排（architecture「系统 cron + 容器内进程」的被触发端）。
 *  一次完整跑：采集所有启用 Source → 按启用 Topic 切窗口内 ContentItem → 分析→校验→生成 brief。
 *  每个 Source / Topic 独立 try/catch，单点失败不连累其余（与 collector / validateBatch 的韧性一致）。
 *  由 /api/cron 触发（系统 cron / supercronic 定时 curl）；含真模型调用，需 ANTHROPIC_API_KEY。 */
import type { DB } from "../db/index.js";
import { getEffectiveSources, loadStaticConfig } from "../config/index.js";
import { listContentForTopic, listTopics } from "../db/repos.js";
import { collectSource } from "./collector.js";
import { runAnalysis, runReportGen, runValidation } from "./pipeline.js";

export interface ScheduleSummary {
  startedAt: string;
  finishedAt: string;
  windowHours: number;
  collected: Array<{ source: string; fetched?: number; inserted?: number; updated?: number; error?: string }>;
  topics: Array<{ topic: string; items: number; reportId?: string; included?: number; status: string }>;
  errors: string[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 触发一次完整管线。库为空时 getEffectiveSources 会先播种默认 Topic/Source（首跑自举）。 */
export async function runScheduledPipeline(
  db: DB,
  opts: { windowHours?: number } = {},
): Promise<ScheduleSummary> {
  const startedAt = new Date().toISOString();
  const windowHours = opts.windowHours ?? Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const end = Date.now();
  const since = new Date(end - windowHours * 3_600_000).toISOString();
  const endIso = new Date(end).toISOString();

  const summary: ScheduleSummary = {
    startedAt,
    finishedAt: startedAt,
    windowHours,
    collected: [],
    topics: [],
    errors: [],
  };

  // 1. 采集：所有启用 Source（库空则同时播种默认配置）
  const sources = getEffectiveSources(db, loadStaticConfig()).filter((s) => s.enabled);
  for (const s of sources) {
    try {
      const r = await collectSource(db, s);
      summary.collected.push({ source: s.id, fetched: r.fetched, inserted: r.inserted, updated: r.updated });
    } catch (e) {
      summary.collected.push({ source: s.id, error: errMsg(e) });
      summary.errors.push(`collect ${s.id}: ${errMsg(e)}`);
    }
  }

  // 2-4. 每个启用 Topic：分析→校验→生成 brief
  for (const topic of listTopics(db, { enabledOnly: true })) {
    const items = listContentForTopic(db, topic.id, { since });
    if (items.length === 0) {
      summary.topics.push({ topic: topic.id, items: 0, status: "skipped-no-content" });
      continue;
    }
    try {
      const batch = await runAnalysis(db, topic, items, { start: since, end: endIso });
      const validation = await runValidation(db, batch, items);
      const report = await runReportGen(db, { topic, batch, validation, type: "brief" });
      summary.topics.push({
        topic: topic.id,
        items: items.length,
        reportId: report.id,
        included: report.insight_ids.length,
        status: "done",
      });
    } catch (e) {
      summary.topics.push({ topic: topic.id, items: items.length, status: `failed: ${errMsg(e)}` });
      summary.errors.push(`pipeline ${topic.id}: ${errMsg(e)}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
