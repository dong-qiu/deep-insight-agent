/** collector —— 数据采集 agent（architecture 数据流第 1 步）。
 *  按 Source 抓取 → 归一化 ContentItem → 去重 → 存档原文 → 落库；全程记一条 ingest Run。
 *  Job Runner（增量4）会接管 Run 编排；此处先用 repos 直接落 Run。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishRun, getContentByUrl, insertContentItem, insertRun, updateContentItem } from "../db/repos.js";
import type { DB } from "../db/index.js";
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
  const runId = `run_${randomUUID().slice(0, 8)}`;
  insertRun(db, {
    id: runId,
    kind: "ingest",
    target: { source_id: source.id },
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_ms: null,
    cost: null,
    error: null,
    retry_of: null,
  });
  try {
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
    finishRun(db, runId, { status: "done" });
    return { runId, fetched: raws.length, inserted, updated, skipped };
  } catch (e) {
    const err = e as Error;
    finishRun(db, runId, { status: "failed", error: { type: err.name, message: err.message } });
    throw e;
  }
}
