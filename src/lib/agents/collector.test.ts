/** collector B族转写抓取（ADR-0007 6a）：抓取移到去重后、只对新 url 抓 + 不降级。
 *  mock 出网（fetchFromSource / fetchTranscript）+ 内存 DB；DATA_DIR 指临时目录供 archiveRaw 写。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawItem } from "../sources/types.js";

// vi.hoisted：mock 工厂提升到 import 之上，用 hoisted 共享受控数据。
const ctl = vi.hoisted(() => ({ raws: [] as RawItem[], transcript: null as string | null }));
vi.mock("../sources/index.js", () => ({ fetchFromSource: vi.fn(async () => ctl.raws) }));
vi.mock("../sources/rss.js", () => ({
  fetchTranscript: vi.fn(async () => ctl.transcript),
  transcriptFetchEnabled: () => process.env.TRANSCRIPT_FETCH === "1",
}));

import { collectSource } from "./collector.js";
import { openDb, type DB } from "../db/index.js";
import { getContentByUrl, getContentItem, insertContentItem, insertSource } from "../db/repos.js";
import { rawToContentItem } from "../sources/normalize.js";
import type { Source } from "../types.js";

const source: Source = {
  id: "s1", name: "Pod", type: "rss", endpoint: "https://pod/feed", industry: "ai-swe",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};
const mkRaw = (url: string, body: string, transcript_url?: string): RawItem =>
  ({ url, title: "Ep", author: null, published_at: null, body, transcript_url, raw: "{}" });

let db: DB;
beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "collector-test-"));
  db = openDb(":memory:");
  insertSource(db, source);
});
afterEach(() => {
  delete process.env.TRANSCRIPT_FETCH;
  ctl.raws = [];
  ctl.transcript = null;
  vi.clearAllMocks();
});

describe("collector B族转写抓取（6a）", () => {
  it("开关开 + 新 url + transcript_url → 抓转写、存 body_kind=transcript", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    ctl.raws = [mkRaw("https://pod/ep1", "Show notes.", "https://pod/ep1.txt")];
    ctl.transcript = "Real transcript body.";
    await collectSource(db, source);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep1")!.id)!;
    expect(item.body_kind).toBe("transcript");
    expect(item.body).toBe("Real transcript body.");
  });

  it("开关开 + 新 url + 抓取失败（返 null）→ 落 show notes（article），仍入库", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    ctl.raws = [mkRaw("https://pod/ep_fail", "Show notes.", "https://pod/ep_fail.txt")];
    ctl.transcript = null; // 抓取失败（robots/网络/超限/空）
    const res = await collectSource(db, source);
    expect(res.inserted).toBe(1);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep_fail")!.id)!;
    expect(item.body_kind).toBe("article");
    expect(item.body).toBe("Show notes.");
  });

  it("开关关 → 新 url 不抓转写，存 show notes（body_kind=article 默认）", async () => {
    ctl.raws = [mkRaw("https://pod/ep2", "Show notes.", "https://pod/ep2.txt")];
    ctl.transcript = "should NOT be used";
    await collectSource(db, source);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep2")!.id)!;
    expect(item.body_kind).toBe("article");
    expect(item.body).toBe("Show notes.");
  });

  it("不降级：已是 transcript 的 url 再采到 show notes → 跳过、保留 transcript", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    const tr = rawToContentItem(
      mkRawWithKind("https://pod/ep3", "Transcript text.", "transcript"),
      source, "2026-06-20T00:00:00Z",
    );
    insertContentItem(db, tr);
    ctl.raws = [mkRaw("https://pod/ep3", "Different show notes now.", "https://pod/ep3.txt")]; // 同 url、show notes
    const res = await collectSource(db, source);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const item = getContentItem(db, tr.id)!;
    expect(item.body_kind).toBe("transcript"); // 未被降级
    expect(item.body).toBe("Transcript text.");
  });
});

function mkRawWithKind(url: string, body: string, kind: RawItem["body_kind"]): RawItem {
  return { url, title: "Ep", author: null, published_at: null, body, body_kind: kind, raw: "{}" };
}
