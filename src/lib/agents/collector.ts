/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；统一经 Job Runner 记一条 ingest Run
 *  （与 analyze/validate/report-gen 一致：单调时钟耗时 + 失败捕获 + 可重试）。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContentByUrl, insertContentItem, updateContentItem } from "../db/repos.js";
import type { DB } from "../db/index.js";
import { runJob } from "../runtime/jobs.js";
import type { Source } from "../types.js";
import { articleFetchEnabled, fetchArticleBody } from "../sources/article.js";
import { fetchFromSource } from "../sources/index.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import { fetchTranscript, transcriptFetchEnabled } from "../sources/rss.js";

export interface CollectResult {
  runId: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/** 单次 collectSource 内全文抓取条数上限（绑首轮全量回填的串行规模）。env ARTICLE_FETCH_MAX_PER_RUN 可覆盖。
 *  超限条目本轮跳过、下轮再抓——抓前去重保证不重抓已采，逐轮把积压新文消化完。
 *  运行期读 env（非模块常量）：便于运行期调 + 单测可控。 */
function articleFetchMaxPerRun(): number {
  return Number(process.env.ARTICLE_FETCH_MAX_PER_RUN) || 25;
}

/** 原文存档到 FS（architecture：raw_ref 句柄，MVP 不清理），返回相对路径句柄。 */
function archiveRaw(id: string, raw: string): string {
  const dir = join(process.env.DATA_DIR ?? ".data", "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.txt`);
  writeFileSync(path, raw);
  return path;
}

export async function collectSource(
  db: DB,
  source: Source,
  opts: { retryOf?: string | null } = {},
): Promise<CollectResult> {
  const { run, result } = await runJob(
    db,
    { kind: "ingest", target: { source_id: source.id }, retryOf: opts.retryOf ?? null },
    async () => {
    const raws = await fetchFromSource(source);
    const fetchedAt = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let articleFetches = 0; // 本轮已抓全文条数（绑首轮全量回填的串行规模，剩余留下轮）
    const articleBudget = articleFetchMaxPerRun();
    for (const raw of raws) {
      if (!raw.body.trim()) {
        // 标题党 feed（body 空，如安全客）：开关开时按 URL 抓文章页补全全文。
        // **抓前去重**：已采过该 URL（库里有非空正文）→ 跳过、不重抓（只抓新文章，避免每轮 cron hammer 源）。
        if (!articleFetchEnabled()) {
          skipped++; // 开关关 → 维持现状：空正文视为抽取失败、不产出条目
          continue;
        }
        // collector 从不插入空正文条目（见下方分支），故该 URL 库里有任何行 = 已采过且有正文 → 不重抓。
        if (getContentByUrl(db, normalizeUrl(raw.url))) {
          skipped++; // 该文章已采 → 复用、不重抓（抓前去重，避免每轮 cron 重抓）
          continue;
        }
        // 单轮全文抓取硬上限：串行抓 robots+page 各有超时，首轮一个 feed 全是新文时防阻塞 collectSource
        // 太久。超限的留到下一轮（抓前去重保证不重抓已采，新文逐轮被消化）。
        if (articleFetches >= articleBudget) {
          skipped++;
          continue;
        }
        articleFetches++;
        const body = await fetchArticleBody(raw.url);
        if (!body) {
          skipped++; // 抓取/抽取失败 → 仍视为抽取失败
          continue;
        }
        raw.body = body;
        raw.body_kind = "article";
      }
      let item = rawToContentItem(raw, source, fetchedAt);
      const existing = getContentByUrl(db, item.url);
      // B族·不降级（6a）：已是 transcript 的 item 不被 show_notes/article 覆盖——防转写被降级 + 旧引用失效（Major6）。
      if (existing?.body_kind === "transcript" && item.body_kind !== "transcript") {
        skipped++;
        continue;
      }
      // B族·只抓新（6a）：库里没有的 url + 有 transcript_url + 开关开 → 抓转写、重建为 transcript item。
      // 「只对新 url 抓」既避免每轮全抓 50 集，又确保已入库 item 永不被原地从 show_notes 改成 transcript（根除 Major6）。
      if (!existing && raw.transcript_url && transcriptFetchEnabled()) {
        const transcript = await fetchTranscript(raw.transcript_url);
        if (transcript) item = rawToContentItem({ ...raw, body: transcript, body_kind: "transcript" }, source, fetchedAt);
      }
      if (existing && existing.content_hash === item.content_hash) {
        skipped++; // 同 URL + 同指纹 = 完全重复（AC2 ①）
        continue;
      }
      item.raw_ref = archiveRaw(item.id, raw.raw);
      if (existing) {
        updateContentItem(db, item); // 同 URL 内容更新 → 原地更新、id 不变（AC2 ②）
        updated++;
      } else {
        insertContentItem(db, item); // 新 URL（AC2 ③）
        inserted++;
      }
    }
      return { fetched: raws.length, inserted, updated, skipped };
    },
  );
  return { runId: run.id, ...result };
}
