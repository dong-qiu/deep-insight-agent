/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；统一经 Job Runner 记一条 ingest Run
 *  （与 analyze/validate/report-gen 一致：单调时钟耗时 + 失败捕获 + 可重试）。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContentByUrl, insertContentItem, updateContentItem } from "../db/repos.js";
import type { DB } from "../db/index.js";
import { runJob } from "../runtime/jobs.js";
import type { Source } from "../types.js";
import { fetchFromSource } from "../sources/index.js";
import { rawToContentItem } from "../sources/normalize.js";

export interface CollectResult {
  runId: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/** 原文存档到 FS（architecture：raw_ref 句柄，MVP 不清理），返回相对路径句柄。 */
function archiveRaw(id: string, raw: string): string {
  const dir = join(process.env.DATA_DIR ?? ".data", "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.txt`);
  writeFileSync(path, raw);
  return path;
}

export async function collectSource(db: DB, source: Source): Promise<CollectResult> {
  const { run, result } = await runJob(db, { kind: "ingest", target: { source_id: source.id } }, async () => {
    const raws = await fetchFromSource(source);
    const fetchedAt = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const raw of raws) {
      if (!raw.body.trim()) {
        skipped++; // 空正文视为抽取失败，不产出条目
        continue;
      }
      const item = rawToContentItem(raw, source, fetchedAt);
      const existing = getContentByUrl(db, item.url);
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
  });
  return { runId: run.id, ...result };
}
