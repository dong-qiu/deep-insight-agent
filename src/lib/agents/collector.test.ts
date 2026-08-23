/** collector 编排测试：① 标题党 RSS 全文回填（#82）② B族转写抓取（ADR-0007 6a）。
 *  mock fetchFromSource（共享 raws）+ fetchArticleBody（#82）+ fetchTranscript（6a）；内存 DB + 临时 DATA_DIR。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DB, openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { claimSourceCollectTrace, createScheduledSourceCollectTrace, getGenerationTraceStatus } from "../db/provenance.js";
import { getContentByUrl, getContentItem, insertContentItem, insertSource } from "../db/repos.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import type { RawItem } from "../sources/types.js";
import type { Source } from "../types.js";

// vi.hoisted：mock 工厂提升到 import 之上，用 hoisted 共享受控数据。
const { raws, article, ctl } = vi.hoisted(() => ({
  raws: { value: [] as RawItem[] },
  article: { fn: vi.fn(async (_url: string) => null as string | null) },
  ctl: { transcript: null as string | null, lastContainer: undefined as string | null | undefined, fetchError: null as Error | null },
}));
vi.mock("../sources/index.js", () => ({ fetchFromSource: vi.fn(async () => {
  if (ctl.fetchError) throw ctl.fetchError;
  return raws.value;
}) }));
vi.mock("../sources/article.js", () => ({
  MIN_ARTICLE_CHARS: 200,
  articleFetchEnabled: () => process.env.ARTICLE_FETCH === "1",
  articleFetchKilled: () => process.env.ARTICLE_FETCH === "0" || process.env.ARTICLE_FETCH === "false",
  fetchArticleBody: (url: string, container?: string | null) => {
    ctl.lastContainer = container; // 捕获按源 container，供透传断言（不影响既有 toHaveBeenCalledWith(url)）
    return article.fn(url);
  },
}));
vi.mock("../sources/rss.js", () => ({
  fetchTranscript: vi.fn(async () => ctl.transcript),
  transcriptFetchEnabled: () => process.env.TRANSCRIPT_FETCH === "1",
}));

const { collectSource } = await import("./collector.js");

const sourceAnq: Source = {
  id: "s_anq", name: "安全客", type: "rss", endpoint: "https://api.anquanke.com/data/v1/rss",
  topic_ids: ["t_sec"], fetch_interval: "1h", backfill: null, enabled: true,
};
const sourcePod: Source = {
  id: "s1", name: "Pod", type: "rss", endpoint: "https://pod/feed",
  topic_ids: ["t1"], fetch_interval: "1h", backfill: null, enabled: true,
};
const sourceFullText: Source = {
  id: "s_ft", name: "先知式", type: "rss", endpoint: "https://xz.example/feed",
  topic_ids: ["t_sec"], fetch_interval: "1h", backfill: null, enabled: true, fetch_mode: "full_text", content_container: null,
};

const titleOnly = (url: string): RawItem => ({
  url, title: "某高危漏洞", author: "安全客", published_at: "2026-06-18 20:00:10", body: "", raw: "{}",
});
const mkRaw = (url: string, body: string, transcript_url?: string): RawItem =>
  ({ url, title: "Ep", author: null, published_at: null, body, transcript_url, raw: "{}" });
const mkRawWithKind = (url: string, body: string, kind: RawItem["body_kind"]): RawItem =>
  ({ url, title: "Ep", author: null, published_at: null, body, body_kind: kind, raw: "{}" });

let db: DB;
beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "collector-test-"));
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertSource(db, sourceAnq);
  insertSource(db, sourcePod);
  insertSource(db, sourceFullText);
  article.fn.mockReset();
});
afterEach(() => {
  delete process.env.ARTICLE_FETCH;
  delete process.env.TRANSCRIPT_FETCH;
  delete process.env.ARTICLE_FETCH_MAX_PER_RUN;
  raws.value = [];
  ctl.transcript = null;
  ctl.fetchError = null;
  vi.clearAllMocks();
});

describe("collector 标题党 RSS 全文回填（#82）", () => {
  it("开关关：空正文条目跳过、不抓全文、不入库", async () => {
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    const r = await collectSource(db, sourceAnq);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("开关开 + 新 URL：抓全文补全 → 入库（body=抓到的正文）", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue("<p>这是抓到的文章正文，足够长可分析。</p>");
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    const r = await collectSource(db, sourceAnq);
    expect(article.fn).toHaveBeenCalledWith("https://www.anquanke.com/post/id/1");
    expect(r.inserted).toBe(1);
    const row = db.prepare("SELECT body FROM content_item WHERE url = ?").get(normalizeUrl("https://www.anquanke.com/post/id/1")) as { body: string } | undefined;
    expect(row?.body).toContain("抓到的文章正文");
  });

  it("开关开 + 已采过该 URL（库里有正文）：不重抓、跳过", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue("<p>这是抓到的文章正文，足够长可分析。</p>");
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    await collectSource(db, sourceAnq);
    article.fn.mockClear();
    const r2 = await collectSource(db, sourceAnq);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r2.skipped).toBe(1);
    expect(r2.inserted).toBe(0);
  });

  it("开关开 + 抓取失败（返 null）：跳过、不入库", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue(null);
    raws.value = [titleOnly("https://www.anquanke.com/post/id/9")];
    const r = await collectSource(db, sourceAnq);
    expect(article.fn).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("单轮全文抓取上限：超过 ARTICLE_FETCH_MAX_PER_RUN 的条目本轮跳过、留下轮", async () => {
    process.env.ARTICLE_FETCH = "1";
    process.env.ARTICLE_FETCH_MAX_PER_RUN = "2";
    article.fn.mockResolvedValue("<p>足够长的文章正文内容可供分析使用。</p>");
    raws.value = [1, 2, 3, 4].map((n) => titleOnly(`https://www.anquanke.com/post/id/${n}`));
    const r = await collectSource(db, sourceAnq);
    expect(article.fn).toHaveBeenCalledTimes(2);
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(2);
  });

  it("有正文的条目不触发全文抓取（仅空正文才抓）", async () => {
    process.env.ARTICLE_FETCH = "1";
    raws.value = [{ ...titleOnly("https://x/full"), body: "feed 自带的完整正文内容，足够长。" }];
    const r = await collectSource(db, sourceAnq);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(1);
  });
});

describe("collector 按源 fetch_mode 全文策略（ADR-0008 切片2）", () => {
  const shortSummary = "八十字以内的短摘要"; // < MIN_ARTICLE_CHARS
  it("full_text 源 + 短正文(非空) → 抓全文（feed 模式不会）", async () => {
    article.fn.mockResolvedValue("<p>抓到的完整文章正文，足够长可供分析使用使用。</p>".repeat(3));
    raws.value = [{ ...mkRaw("https://xz.example/news/1", shortSummary) }];
    const r = await collectSource(db, sourceFullText);
    expect(article.fn).toHaveBeenCalledWith("https://xz.example/news/1");
    expect(r.inserted).toBe(1);
    const item = getContentItem(db, getContentByUrl(db, "https://xz.example/news/1")!.id)!;
    expect(item.body).toContain("抓到的完整文章正文");
  });

  it("full_text 源 → 不需全局 ARTICLE_FETCH 开（按源声明优先、绕过 legacy 默认关）", async () => {
    delete process.env.ARTICLE_FETCH; // 全局关
    article.fn.mockResolvedValue("<p>足够长的文章正文内容供分析。</p>".repeat(3));
    raws.value = [titleOnly("https://xz.example/news/2")]; // 空正文
    const r = await collectSource(db, sourceFullText);
    expect(article.fn).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(1);
  });

  it("full_text 源 + 应急熔断 ARTICLE_FETCH=0 → 不抓", async () => {
    process.env.ARTICLE_FETCH = "0";
    raws.value = [titleOnly("https://xz.example/news/3")];
    const r = await collectSource(db, sourceFullText);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("feed 源 + 短正文(非空) → 不抓、原样落库短摘要", async () => {
    raws.value = [{ ...mkRaw("https://x/short", shortSummary) }];
    const r = await collectSource(db, sourcePod);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(1);
    const item = getContentItem(db, getContentByUrl(db, "https://x/short")!.id)!;
    expect(item.body).toBe(shortSummary);
  });

  it("full_text 源 + 抓失败 + 原本短正文 → 回退落库短摘要（不丢条目）", async () => {
    article.fn.mockResolvedValue(null);
    raws.value = [{ ...mkRaw("https://xz.example/news/4", shortSummary) }];
    const r = await collectSource(db, sourceFullText);
    expect(article.fn).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(1); // 短摘要回退入库
  });

  it("按源 content_container 透传到 fetchArticleBody（端到端）", async () => {
    article.fn.mockResolvedValue("<p>足够长的文章正文内容供分析使用。</p>".repeat(3));
    const src: Source = { ...sourceFullText, id: "s_ct", content_container: "js-article" };
    insertSource(db, src);
    raws.value = [titleOnly("https://xz.example/news/ct")];
    await collectSource(db, src);
    expect(ctl.lastContainer).toBe("js-article");
  });
});

describe("collector B族转写抓取（6a）", () => {
  it("开关开 + 新 url + transcript_url → 抓转写、存 body_kind=transcript", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    raws.value = [mkRaw("https://pod/ep1", "Show notes.", "https://pod/ep1.txt")];
    ctl.transcript = "Real transcript body.";
    await collectSource(db, sourcePod);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep1")!.id)!;
    expect(item.body_kind).toBe("transcript");
    expect(item.body).toBe("Real transcript body.");
  });

  it("开关开 + 新 url + 抓取失败（返 null）→ 落 show notes（article），仍入库", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    raws.value = [mkRaw("https://pod/ep_fail", "Show notes.", "https://pod/ep_fail.txt")];
    ctl.transcript = null;
    const res = await collectSource(db, sourcePod);
    expect(res.inserted).toBe(1);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep_fail")!.id)!;
    expect(item.body_kind).toBe("article");
    expect(item.body).toBe("Show notes.");
  });

  it("开关关 → 新 url 不抓转写，存 show notes（body_kind=article 默认）", async () => {
    raws.value = [mkRaw("https://pod/ep2", "Show notes.", "https://pod/ep2.txt")];
    ctl.transcript = "should NOT be used";
    await collectSource(db, sourcePod);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep2")!.id)!;
    expect(item.body_kind).toBe("article");
    expect(item.body).toBe("Show notes.");
  });

  it("不降级：已是 transcript 的 url 再采到 show notes → 跳过、保留 transcript", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    const tr = rawToContentItem(mkRawWithKind("https://pod/ep3", "Transcript text.", "transcript"), sourcePod, "2026-06-20T00:00:00Z");
    insertContentItem(db, tr);
    raws.value = [mkRaw("https://pod/ep3", "Different show notes now.", "https://pod/ep3.txt")];
    const res = await collectSource(db, sourcePod);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const item = getContentItem(db, tr.id)!;
    expect(item.body_kind).toBe("transcript");
    expect(item.body).toBe("Transcript text.");
  });
});

describe("collector P0b-1 source_collect provenance", () => {
  it("以 source scoped trace 固化 source / Content revision，并以同一 ingest Run 作为根", async () => {
    raws.value = [mkRaw("https://pod/provenance", "A durable, normalized item.")];
    const now = new Date();
    const accepted = createScheduledSourceCollectTrace(db, {
      sourceId: sourcePod.id,
      now,
    });
    if (accepted.kind !== "accepted") throw new Error("expected source trace accepted");
    const claim = claimSourceCollectTrace(db, accepted.traceId, now);
    if (!claim) throw new Error("expected source trace claim");

    const result = await collectSource(db, sourcePod, { traceClaim: claim });
    expect(getGenerationTraceStatus(db, accepted.traceId)).toMatchObject({
      trace_id: accepted.traceId, source_id: sourcePod.id, scope_kind: "source_collect",
      status: "done", root_run_id: result.runId,
    });
    expect(db.prepare("SELECT trace_id FROM run WHERE id=?").get(result.runId)).toEqual({ trace_id: accepted.traceId });
    expect(db.prepare("SELECT stage,event_type FROM generation_event WHERE trace_id=? ORDER BY sequence").all(accepted.traceId)).toEqual([
      { stage: "collect", event_type: "started" },
      { stage: "collect", event_type: "completed" },
      { stage: "normalize", event_type: "started" },
      { stage: "normalize", event_type: "completed" },
    ]);
    const content = getContentByUrl(db, "https://pod/provenance")!;
    const revision = db.prepare("SELECT snapshot FROM provenance_revision WHERE entity_type='content_item'").get() as { snapshot: string };
    expect(revision.snapshot).toContain(content.content_hash);
    expect(revision.snapshot).not.toContain("raw_ref");
    expect(db.prepare("SELECT state FROM generation_trace_request WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "terminal" });
    expect(db.prepare("SELECT state FROM generation_lease WHERE trace_id=?").get(accepted.traceId)).toEqual({ state: "released" });
    expect(db.prepare("SELECT topic_id,source_id,stage FROM funnel_event WHERE run_id=?").get(result.runId)).toEqual({ topic_id: "t1", source_id: "s1", stage: "received" });
  });

  it("抓取失败时留下 collect failed，并显式声明没有已提交、未知的 Content 输出", async () => {
    raws.value = [];
    const source = { ...sourcePod, id: "s_fail" };
    insertSource(db, source);
    const now = new Date();
    const accepted = createScheduledSourceCollectTrace(db, {
      sourceId: source.id,
      now,
    });
    if (accepted.kind !== "accepted") throw new Error("expected source trace accepted");
    const claim = claimSourceCollectTrace(db, accepted.traceId, now);
    if (!claim) throw new Error("expected source trace claim");
    ctl.fetchError = new Error("feed unavailable");

    await expect(collectSource(db, source, { traceClaim: claim })).rejects.toThrow("feed unavailable");
    expect(getGenerationTraceStatus(db, accepted.traceId)?.status).toBe("failed");
    const event = db.prepare("SELECT metrics FROM generation_event WHERE trace_id=? AND stage='collect' AND event_type='failed'").get(accepted.traceId) as { metrics: string };
    expect(JSON.parse(event.metrics)).toMatchObject({
      committed_output_ref_count: 0,
      rolled_back_output_ref_count: 1,
      unknown_output_ref_count: 0,
    });
  });
});
