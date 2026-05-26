/** 定时管线编排（architecture「系统 cron + 容器内进程」的被触发端）。
 *  一次完整跑：采集所有启用 Source → 按启用 Topic 切窗口内 ContentItem → 分析→校验→生成 brief。
 *  每个 Source / Topic 独立 try/catch，单点失败不连累其余（与 collector / validateBatch 的韧性一致）。
 *  由 /api/cron 触发（系统 cron / supercronic 定时 curl）；含真模型调用，需 ANTHROPIC_API_KEY。 */
import type { DB } from "../db/index.js";
import { getEffectiveSources, loadStaticConfig } from "../config/index.js";
import { listContentForTopic, listTopics } from "../db/repos.js";
import type { ContentItem, Topic } from "../types.js";
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

/** 关键词相关度 = 命中的不同关键词数（title+body 小写子串匹配）。 */
function relevanceScore(item: ContentItem, keywords: string[]): number {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  return keywords.reduce((n, k) => (k && hay.includes(k) ? n + 1 : n), 0);
}

/** 纯函数：从候选池按「相关度优先 + 来源多样」选出 ≤ limit 条用于分析。
 *  - 优先相关（命中关键词）的条目；若全 0 命中则回退按候选池既有顺序（recency）；
 *  - 每源最多 ceil(limit/3) 条，避免高产源（如 OpenAI 全历史 backlog）独占切片淹没相关内容；
 *  - 名额没填满则放开每源上限补齐。 */
export function rankAndDiversify(
  candidates: ContentItem[],
  keywords: string[],
  limit: number,
): ContentItem[] {
  if (candidates.length <= limit) return candidates;
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const scored = candidates.map((it, i) => ({ it, s: relevanceScore(it, kws), i }));
  const relevant = scored.filter((x) => x.s > 0);
  // 相关项按相关度降序（同分保持 recency）；无相关项则用原序回退
  const ranked = (relevant.length ? relevant : scored).sort((a, b) => b.s - a.s || a.i - b.i);

  const perSourceCap = Math.max(2, Math.ceil(limit / 3));
  const bySource = new Map<string, number>();
  const out: ContentItem[] = [];
  for (const { it } of ranked) {
    if (out.length >= limit) break;
    const c = bySource.get(it.source_id) ?? 0;
    if (c >= perSourceCap) continue;
    bySource.set(it.source_id, c + 1);
    out.push(it);
  }
  if (out.length < limit) {
    for (const { it } of ranked) {
      if (out.length >= limit) break;
      if (!out.includes(it)) out.push(it);
    }
  }
  return out;
}

/** 取某主题窗口内候选（recency 前 candidatePool 条）→ 相关+多样选 ≤ limit 条喂给 analyzer。 */
export function selectAnalysisItems(
  db: DB,
  topic: Topic,
  opts: { since: string; limit?: number; candidatePool?: number },
): ContentItem[] {
  const limit = opts.limit ?? 15;
  const candidates = listContentForTopic(db, topic.id, {
    since: opts.since,
    limit: opts.candidatePool ?? 300,
  });
  return rankAndDiversify(candidates, topic.keywords, limit);
}

/** 触发一次完整管线。库为空时 getEffectiveSources 会先播种默认 Topic/Source（首跑自举）。 */
export async function runScheduledPipeline(
  db: DB,
  opts: { windowHours?: number; itemsPerTopic?: number } = {},
): Promise<ScheduleSummary> {
  const startedAt = new Date().toISOString();
  const windowHours = opts.windowHours ?? Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const itemsPerTopic = opts.itemsPerTopic ?? (Number(process.env.PIPELINE_ITEMS_PER_TOPIC) || 15);
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
    const items = selectAnalysisItems(db, topic, { since, limit: itemsPerTopic });
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
