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

/** 把关键词拆成可匹配 token：英文按词、≥3 字符；CJK 片段 ≥2 字符。
 *  整短语子串匹配过脆（中文关键词永不命中英文摘要、英文长短语少见原样出现，曾把 arXiv 研究全过滤掉），
 *  按 token 命中可让英文研究摘要靠 software/agent/retrieval/inference 等词被识别为相关。 */
export function keywordTokens(keywords: string[]): string[] {
  const toks = new Set<string>();
  for (const kw of keywords) {
    for (const t of kw.toLowerCase().split(/[\s/]+/)) {
      const minLen = /[a-z]/.test(t) ? 3 : 2;
      if (t.length >= minLen) toks.add(t);
    }
  }
  return [...toks];
}

/** 相关度 = 命中的不同关键词 token 数（title+body 小写子串匹配）。 */
function relevanceScore(item: ContentItem, tokens: string[]): number {
  const hay = `${item.title} ${item.body}`.toLowerCase();
  return tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

/** 纯函数：从候选池按「相关度优先 + 来源多样」选出 ≤ limit 条用于分析。
 *  - 全量按相关度（token 命中数）降序，同分保持 recency；不再硬过滤 0 命中——
 *    研究源（如 arXiv）即便措辞不同也多能命中 token；万一全 0 也由来源多样化兜底纳入；
 *  - 每源最多 ceil(limit/3) 条，避免高产源（如 OpenAI 全历史 backlog）独占切片淹没相关内容；
 *  - 名额没填满则放开每源上限补齐。 */
export function rankAndDiversify(
  candidates: ContentItem[],
  keywords: string[],
  limit: number,
): ContentItem[] {
  if (candidates.length <= limit) return candidates;
  const tokens = keywordTokens(keywords);
  const ranked = candidates
    .map((it, i) => ({ it, s: relevanceScore(it, tokens), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i);

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
  // 候选池放大到覆盖 F1 后全行业量（每源 ≤50 × 源数），避免高产源按 recency 把研究源（arXiv）
  // 挤出候选窗口、scoring 根本看不到它。打分是内存子串匹配，候选多也廉价。
  const candidates = listContentForTopic(db, topic.id, {
    since: opts.since,
    limit: opts.candidatePool ?? 800,
  });
  return rankAndDiversify(candidates, topic.keywords, limit);
}

/** 触发一次完整管线。库为空时 getEffectiveSources 会先播种默认 Topic/Source（首跑自举）。 */
export async function runScheduledPipeline(
  db: DB,
  opts: { windowHours?: number; itemsPerTopic?: number; reportType?: "brief" | "deep_dive" } = {},
): Promise<ScheduleSummary> {
  const startedAt = new Date().toISOString();
  const windowHours = opts.windowHours ?? Number(process.env.PIPELINE_WINDOW_HOURS ?? 168);
  const itemsPerTopic = opts.itemsPerTopic ?? (Number(process.env.PIPELINE_ITEMS_PER_TOPIC) || 15);
  const reportType = opts.reportType ?? "brief"; // 每日 brief / 周报 deep_dive（cron 按周期传入）
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
      const report = await runReportGen(db, { topic, batch, validation, type: reportType });
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
