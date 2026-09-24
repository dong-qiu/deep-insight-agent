/** collector 编排测试：标题党 RSS 全文回填（#82）及播客证据不变量。
 *  mock fetchFromSource（共享 raws）+ fetchArticle（#82）；内存 DB + 临时 DATA_DIR。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DB, openDb } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry-sqlite.js";
import { claimSourceCollectTrace, createScheduledSourceCollectTrace, createSourceCollectTrace, getGenerationTraceStatus } from "../db/provenance.js";
import { getContentByUrl, getContentItem, insertContentItem, insertSource, insertTopic, listContentForTopic } from "../db/repos.js";
import { captureRevision, entityKey } from "../db/provenance-facts.js";
import { contentItemRef, contentItemRevisionSnapshot } from "../db/provenance-revisions.js";
import * as rawArchive from "../db/raw-archive.js";
import { checkReachability } from "./validator.js";
import { normalizeUrl, rawToContentItem } from "../sources/normalize.js";
import type { RawItem } from "../sources/types.js";
import type { Source } from "../types.js";

// vi.hoisted：mock 工厂提升到 import 之上，用 hoisted 共享受控数据。
const { raws, article, ctl } = vi.hoisted(() => ({
  raws: { value: [] as RawItem[] },
  article: { fn: vi.fn(async (_url: string) => null as { raw_html: string; body_html: string } | string | null) },
  ctl: {
    lastContainer: undefined as string | null | undefined, fetchError: null as Error | null,
    transcriptCalls: 0,
    transcript: {
      outcome: "success" as const, stable_url: "https://pod/transcript.txt", raw_payload: "raw transcript",
      cleaned_body: "clean body", bytes: 14, duration_ms: 5, content_type: "text/plain",
    },
    programPage: {
      outcome: "success" as const, stable_url: "https://pod/episode", raw_payload: "<html>episode</html>",
      bytes: 20, duration_ms: 4, content_type: "text/html",
    },
  },
}));
vi.mock("../sources/index.js", () => ({ fetchFromSource: vi.fn(async () => {
  if (ctl.fetchError) throw ctl.fetchError;
  return raws.value;
}) }));
vi.mock("../sources/article.js", () => ({
  articleFetchEnabled: () => process.env.ARTICLE_FETCH === "1",
  articleFetchKilled: () => process.env.ARTICLE_FETCH === "0" || process.env.ARTICLE_FETCH === "false",
  fetchArticle: async (url: string, container?: string | null) => {
    ctl.lastContainer = container; // 捕获按源 container，供透传断言（不影响既有 toHaveBeenCalledWith(url)）
    const result = await article.fn(url);
    return typeof result === "string" ? { raw_html: `<html><body>${result}</body></html>`, body_html: result } : result;
  },
}));
vi.mock("../sources/rss.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/rss.js")>();
  return {
    ...actual,
    fetchTranscript: vi.fn(async () => {
      ctl.transcriptCalls++;
      return ctl.transcript;
    }),
    fetchPodcastProgramPage: vi.fn(async () => ctl.programPage),
  };
});
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
const mkPodcastRaw = (url: string, body: string, transcript_url?: string): RawItem =>
  ({ ...mkRawWithKind(url, body, "show_notes"), title: "Coding agent episode", is_podcast_episode: true, transcript_url });

let db: DB;
beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "collector-test-"));
  db = openDb(":memory:");
  applyProvenanceMigrations(db);
  insertSource(db, sourceAnq);
  insertSource(db, sourcePod);
  insertSource(db, sourceFullText);
  insertTopic(db, { id: "t1", name: "Agents", keywords: ["coding agent"], language: "en", brief_schedule: "daily", enabled: true, facets: [] });
  article.fn.mockReset();
});
afterEach(() => {
  delete process.env.ARTICLE_FETCH;
  delete process.env.TRANSCRIPT_FETCH;
  delete process.env.TRANSCRIPT_SHADOW_FETCH;
  delete process.env.ARTICLE_FETCH_MAX_PER_RUN;
  raws.value = [];
  ctl.fetchError = null;
  ctl.transcriptCalls = 0;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("collector 标题党 RSS 全文回填（#82）", () => {
  it("production commits a durable raw_archive effect and a readable raw_ref", async () => {
    vi.stubEnv("NODE_ENV", "production");
    raws.value = [{ ...mkRaw("https://example.test/raw-gated", "body"), raw: "original raw payload" }];
    await collectSource(db, sourcePod);
    const item = db.prepare("SELECT id,raw_ref FROM content_item WHERE url=?").get("https://example.test/raw-gated") as { id: string; raw_ref: string };
    expect(item.raw_ref).toMatch(/^raw\/ci_[a-f0-9]{16}\.[a-f0-9]{64}\.txt$/);
    expect(JSON.parse(readFileSync(join(process.env.DATA_DIR!, item.raw_ref), "utf8"))).toMatchObject({
      schema_version: "content-raw-archive-v1",
      source_body_origin: "feed",
      source_body: "body",
      source_item_raw: "original raw payload",
    });
    expect(db.prepare("SELECT kind,status,raw_content_id FROM generation_effect WHERE raw_content_id=?").get(item.id))
      .toEqual({ kind: "raw_archive", status: "committed", raw_content_id: item.id });
  });

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

  it("full_text 源 + 很长 RSS 摘要仍必须抓文章页，并将响应与结构化正文共同归档", async () => {
    const summary = "RSS 摘要看似已经很长，但不能证明它是文章全文。".repeat(30);
    const articleHtml = `<html><body><article><p>${"完整文章正文。".repeat(80)}</p></article></body></html>`;
    article.fn.mockResolvedValue({ raw_html: articleHtml, body_html: `<p>${"完整文章正文。".repeat(80)}</p>` });
    raws.value = [{ ...mkRaw("https://xz.example/news/long-summary", summary) }];

    await collectSource(db, sourceFullText);

    expect(article.fn).toHaveBeenCalledWith("https://xz.example/news/long-summary");
    const item = getContentItem(db, getContentByUrl(db, "https://xz.example/news/long-summary")!.id)!;
    expect(item).toMatchObject({ fetch_status: "ok" });
    expect(item.body).toContain("完整文章正文");
    const archive = JSON.parse(readFileSync(join(process.env.DATA_DIR!, item.raw_ref), "utf8"));
    expect(archive).toMatchObject({
      schema_version: "content-raw-archive-v1",
      source_body_origin: "article_page",
      source_body: `<p>${"完整文章正文。".repeat(80)}</p>`,
      article_html: articleHtml,
      structured_body_sha256: item.content_hash,
    });
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

  it("应急熔断不会用 RSS 摘要覆盖已完整抓取的同 URL 正文", async () => {
    const url = "https://xz.example/news/no-downgrade";
    article.fn.mockResolvedValue("<p>已抓取的完整文章正文。</p>".repeat(20));
    raws.value = [mkRaw(url, "首次看到的 RSS 摘要")];
    await collectSource(db, sourceFullText);
    process.env.ARTICLE_FETCH = "0";
    article.fn.mockClear();
    raws.value = [mkRaw(url, "稍后 feed 更新的摘要，不能覆盖完整正文")];
    const result = await collectSource(db, sourceFullText);
    const item = getContentItem(db, getContentByUrl(db, url)!.id)!;
    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    expect(article.fn).not.toHaveBeenCalled();
    expect(item).toMatchObject({ fetch_status: "ok" });
    expect(item.body).toContain("已抓取的完整文章正文");
  });

  it("feed 源 + 短正文(非空) → 不抓、原样落库短摘要", async () => {
    raws.value = [{ ...mkRaw("https://x/short", shortSummary) }];
    const r = await collectSource(db, sourcePod);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(1);
    const item = getContentItem(db, getContentByUrl(db, "https://x/short")!.id)!;
    expect(item.body).toBe(shortSummary);
  });

  it("full_text 源 + 抓失败 + 原本短正文 → 回退落库短摘要并标 partial", async () => {
    article.fn.mockResolvedValue(null);
    raws.value = [{ ...mkRaw("https://xz.example/news/4", shortSummary) }];
    const r = await collectSource(db, sourceFullText);
    expect(article.fn).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(1); // 短摘要回退入库
    const item = getContentItem(db, getContentByUrl(db, "https://xz.example/news/4")!.id)!;
    expect(item.fetch_status).toBe("partial");
  });

  it("按源 content_container 透传到 fetchArticle（端到端）", async () => {
    article.fn.mockResolvedValue("<p>足够长的文章正文内容供分析使用。</p>".repeat(3));
    const src: Source = { ...sourceFullText, id: "s_ct", content_container: "js-article" };
    insertSource(db, src);
    raws.value = [titleOnly("https://xz.example/news/ct")];
    await collectSource(db, src);
    expect(ctl.lastContainer).toBe("js-article");
  });
});

describe("collector preserves existing transcript evidence", () => {
  it("在预筛与配额 collector 合入前，enabled 策略也不从生产 collector 请求 transcript", async () => {
    const policySource: Source = {
      ...sourcePod, id: "s_policy", endpoint: "https://pod/policy-feed",
      transcript_mode: "enabled", transcript_policy_version: "podcast-policy-v1",
    };
    insertSource(db, policySource);
    raws.value = [{ ...mkRawWithKind("https://pod/ep-staged", "Show notes.", "show_notes"), transcript_url: "https://pod/ep-staged.txt" }];
    await collectSource(db, policySource);
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep-staged")!.id)!;
    expect(item).toMatchObject({ body_kind: "show_notes", body: "Show notes." });
  });

  it("observe 只写候选/决策事实，绝不抓取或替换生产 show_notes", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    raws.value = [mkPodcastRaw("https://pod/ep_observe", "Show notes.", "https://pod/ep_observe.txt")];
    await collectSource(db, { ...sourcePod, transcript_mode: "observe", transcript_policy_version: "podcast-policy-v1" });
    const item = getContentItem(db, getContentByUrl(db, "https://pod/ep_observe")!.id)!;
    expect(item).toMatchObject({ body_kind: "show_notes", body: "Show notes." });
    expect(ctl.transcriptCalls).toBe(0);
    expect(db.prepare("SELECT stage,outcome,decision FROM transcript_acquisition_fact WHERE source_id=? ORDER BY stage").all(sourcePod.id))
      .toEqual([{ stage: "candidate", outcome: "not_attempted", decision: "fetch" }, { stage: "decision", outcome: "decision", decision: "fetch" }]);
  });

  it("observe 的显式 shadow 开关只写隔离 SQLite/archive，不进入生产 ContentItem", async () => {
    process.env.TRANSCRIPT_FETCH = "1";
    process.env.TRANSCRIPT_SHADOW_FETCH = "1";
    raws.value = [{
      ...mkPodcastRaw("https://pod/ep_shadow", "Show notes.", "https://pod/ep_shadow.txt?token=ephemeral"),
      raw: JSON.stringify({ "podcast:transcript": { "@_url": "https://pod/ep_shadow.txt?token=ephemeral" } }),
    }];
    ctl.transcript = { ...ctl.transcript, raw_payload: "raw shadow transcript", cleaned_body: "Shadow-only transcript." };
    await collectSource(db, { ...sourcePod, transcript_mode: "observe", transcript_policy_version: "podcast-policy-v1" });
    expect(getContentItem(db, getContentByUrl(db, "https://pod/ep_shadow")!.id)!).toMatchObject({ body_kind: "show_notes", body: "Show notes." });
    const shadow = openDb(join(process.env.DATA_DIR!, "podcast-shadow", "shadow.db"));
    const row = shadow.prepare("SELECT outcome,raw_ref,evidence_status FROM transcript_acquisition_fact WHERE source_id=? AND stage='terminal'").get(sourcePod.id) as { outcome: string; raw_ref: string; evidence_status: string };
    shadow.close();
    expect(row).toMatchObject({ outcome: "success", evidence_status: "verified" });
    const archive = JSON.parse(readFileSync(join(process.env.DATA_DIR!, "podcast-shadow", row.raw_ref), "utf8"));
    expect(archive).toMatchObject({
      schema_version: "podcast-transcript-evidence-v2",
      program_page: { raw_payload: "<html>episode</html>" },
      transcript: { raw_payload: "raw shadow transcript" },
    });
    expect(archive.episode.rss_item).not.toContain("token=ephemeral");
    expect(ctl.transcriptCalls).toBe(1);
  });

  it("observe 的 shadow 子开关不能绕过 TRANSCRIPT_FETCH 总熔断", async () => {
    process.env.TRANSCRIPT_SHADOW_FETCH = "1";
    raws.value = [mkPodcastRaw("https://pod/ep-global-gate", "Show notes.", "https://pod/ep-global-gate.txt")];
    await collectSource(db, { ...sourcePod, transcript_mode: "observe", transcript_policy_version: "podcast-policy-v1" });
    expect(ctl.transcriptCalls).toBe(0);
    expect(existsSync(join(process.env.DATA_DIR!, "podcast-shadow", "shadow.db"))).toBe(false);
  });

  it("observe metadata facts never persist episode URL credentials", async () => {
    raws.value = [mkPodcastRaw(
      "https://reader:secret@pod/ep-fact?lang=en&token=ephemeral",
      "Show notes.",
      "https://pod/ep-fact.txt?token=ephemeral",
    )];
    await collectSource(db, { ...sourcePod, transcript_mode: "observe", transcript_policy_version: "podcast-policy-v1" });
    const facts = db.prepare("SELECT canonical_episode_url FROM transcript_acquisition_fact WHERE source_id=? ORDER BY stage")
      .all(sourcePod.id) as Array<{ canonical_episode_url: string }>;
    expect(facts).toEqual([
      { canonical_episode_url: "https://pod/ep-fact?lang=en" },
      { canonical_episode_url: "https://pod/ep-fact?lang=en" },
    ]);
    expect(JSON.stringify(facts)).not.toContain("secret");
    expect(JSON.stringify(facts)).not.toContain("ephemeral");
  });

  it("重复采集同一播客候选时不制造 acquisition conflict", async () => {
    raws.value = [mkPodcastRaw("https://pod/ep-repeat", "Show notes.", "https://pod/ep-repeat.txt")];
    const observing = { ...sourcePod, transcript_mode: "observe" as const, transcript_policy_version: "podcast-policy-v1" };
    await collectSource(db, observing);
    await collectSource(db, observing);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transcript_acquisition_fact WHERE source_id=?").get(sourcePod.id)).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transcript_acquisition_conflict").get()).toEqual({ count: 0 });
  });

  it("podcast RSS 即使配置 full_text 也保持 show_notes，不额外抓节目页覆盖分类", async () => {
    const fullTextPodcast = { ...sourcePod, id: "s_podcast_full_text", fetch_mode: "full_text" as const };
    insertSource(db, fullTextPodcast);
    raws.value = [mkPodcastRaw("https://pod/ep-show-notes", "short show notes", "https://pod/ep-show-notes.txt")];
    await collectSource(db, fullTextPodcast);
    expect(article.fn).not.toHaveBeenCalled();
    expect(getContentItem(db, getContentByUrl(db, "https://pod/ep-show-notes")!.id)!).toMatchObject({ body_kind: "show_notes", body: "short show notes" });
  });

  it("不降级：已是 transcript 的 url 再采到 show notes → 跳过、保留 transcript", async () => {
    const tr = rawToContentItem(mkRawWithKind("https://pod/ep3", "Transcript text.", "transcript"), sourceAnq, "2026-06-20T00:00:00Z");
    insertContentItem(db, tr);
    raws.value = [mkRaw("https://pod/ep3", "Different show notes now.", "https://pod/ep3.txt")];
    const res = await collectSource(db, sourceAnq);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const item = getContentItem(db, tr.id)!;
    expect(item.body_kind).toBe("transcript");
    expect(item.body).toBe("Transcript text.");
  });

  it("不升级：既有 article 的 URL 后来被识别为播客 show notes → 跳过、保留首次形态", async () => {
    const article = rawToContentItem(mkRaw("https://pod/ep-article", "Original article body."), sourceAnq, "2026-06-20T00:00:00Z");
    insertContentItem(db, article);
    raws.value = [mkRawWithKind("https://pod/ep-article", "New show notes body.", "show_notes")];
    const res = await collectSource(db, sourceAnq);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const item = getContentItem(db, article.id)!;
    expect(item).toMatchObject({ body_kind: "article", body: "Original article body." });
  });
});

describe("collector P0b-1 source_collect provenance", () => {
  it("table-drives API, probe and retry collection through request, owned lease, Run and terminal facts", async () => {
    const completed = new Map<string, { traceId: string; runId: string }>();
    const cases: Array<{ name: "api" | "probe" | "retry"; parent?: "api" }> = [
      { name: "api" }, { name: "probe" }, { name: "retry", parent: "api" },
    ];
    for (const [index, entry] of cases.entries()) {
      raws.value = [mkRaw(`https://pod/entry-${entry.name}`, `entry ${entry.name} ${index}`)];
      const accepted = createSourceCollectTrace(db, {
        sourceId: sourcePod.id, triggerKind: entry.name,
        ...(entry.parent ? { retryOfTraceId: completed.get(entry.parent)!.traceId, retryOfRunId: completed.get(entry.parent)!.runId } : {}),
      });
      if (accepted.kind !== "accepted") throw new Error(`expected ${entry.name} trace accepted`);
      const claim = claimSourceCollectTrace(db, accepted.traceId);
      if (!claim) throw new Error(`expected ${entry.name} claim`);
      const result = await collectSource(db, sourcePod, { traceClaim: claim, probe: entry.name === "probe", retryOf: entry.parent ? completed.get(entry.parent)!.runId : null });
      completed.set(entry.name, { traceId: accepted.traceId, runId: result.runId });

      expect(getGenerationTraceStatus(db, accepted.traceId)).toMatchObject({
        trace_id: accepted.traceId, status: "done", root_run_id: result.runId, source_id: sourcePod.id,
      });
      expect(db.prepare("SELECT trace_id,retry_of FROM run WHERE id=?").get(result.runId)).toEqual({
        trace_id: accepted.traceId, retry_of: entry.parent ? completed.get(entry.parent)!.runId : null,
      });
      expect(db.prepare("SELECT stage,event_type FROM generation_event WHERE trace_id=? ORDER BY sequence").all(accepted.traceId))
        .toEqual(expect.arrayContaining([
          { stage: "collect", event_type: "started" }, { stage: "normalize", event_type: "completed" },
        ]));
      const revisions = db.prepare("SELECT COUNT(*) AS count FROM provenance_revision WHERE entity_type='content_item'").get() as { count: number };
      const refs = db.prepare("SELECT COUNT(*) AS count FROM generation_entity_ref WHERE trace_id=?").get(accepted.traceId) as { count: number };
      expect(revisions.count).toBeGreaterThanOrEqual(1);
      expect(refs.count).toBeGreaterThanOrEqual(2);
    }
    expect(db.prepare("SELECT retry_of_trace_id FROM generation_trace WHERE id=?").get(completed.get("retry")!.traceId)).toEqual({
      retry_of_trace_id: completed.get("api")!.traceId,
    });
  });

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

    const result = await collectSource(db, sourcePod, { traceClaim: claim, telemetry: SQLITE_P1_TELEMETRY_SINK });
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

  it("同 URL 被另一来源更新时，Content revision 记录业务表保留的来源元数据", async () => {
    const secondSource: Source = { ...sourcePod, id: "s_second", name: "Second source", endpoint: "https://second/feed", topic_ids: ["t_second"] };
    insertSource(db, secondSource);
    const url = "https://shared.example/article";
    const firstPublishedAt = "2026-08-26T11:00:00.000Z";
    const now = new Date();

    raws.value = [{ ...mkRaw(url, "first source body"), published_at: firstPublishedAt }];
    const firstAccepted = createScheduledSourceCollectTrace(db, { sourceId: sourcePod.id, now });
    if (firstAccepted.kind !== "accepted") throw new Error("expected first source trace");
    const firstClaim = claimSourceCollectTrace(db, firstAccepted.traceId, now);
    if (!firstClaim) throw new Error("expected first source claim");
    await collectSource(db, sourcePod, { traceClaim: firstClaim, telemetry: SQLITE_P1_TELEMETRY_SINK });

    raws.value = [{ ...mkRaw(url, "second source body with a changed revision"), published_at: "2026-08-26T14:00:00.000Z" }];
    const secondAccepted = createScheduledSourceCollectTrace(db, { sourceId: secondSource.id, now });
    if (secondAccepted.kind !== "accepted") throw new Error("expected second source trace");
    const secondClaim = claimSourceCollectTrace(db, secondAccepted.traceId, now);
    if (!secondClaim) throw new Error("expected second source claim");
    const secondResult = await collectSource(db, secondSource, { traceClaim: secondClaim, telemetry: SQLITE_P1_TELEMETRY_SINK });

    const persisted = getContentItem(db, getContentByUrl(db, url)!.id)!;
    expect(persisted).toMatchObject({ source_id: sourcePod.id, published_at: firstPublishedAt, topic_ids: sourcePod.topic_ids, body: "second source body with a changed revision" });
    const ref = contentItemRef(persisted);
    const registered = db.prepare("SELECT snapshot FROM provenance_revision WHERE entity_type=? AND entity_key=? AND revision=?")
      .get(ref.type, entityKey(ref), ref.revision) as { snapshot: string } | undefined;
    expect(registered && JSON.parse(registered.snapshot)).toEqual(contentItemRevisionSnapshot(persisted));
    expect(() => captureRevision(db, {
      entity_type: ref.type, entity_key: entityKey(ref), revision: ref.revision,
      snapshot: contentItemRevisionSnapshot(persisted),
    })).not.toThrow();
    expect(db.prepare("SELECT source_id,topic_id FROM funnel_event WHERE run_id=?").all(secondResult.runId)).toEqual([
      { source_id: sourcePod.id, topic_id: sourcePod.topic_ids[0] },
    ]);
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

  it("archive write failure keeps the committed intent out of readers and records its unknown revision", async () => {
    const now = new Date();
    raws.value = [{ ...mkRaw("https://example.test/raw-write-failure", "body"), raw: "original raw payload" }];
    const accepted = createScheduledSourceCollectTrace(db, { sourceId: sourcePod.id, now });
    if (accepted.kind !== "accepted") throw new Error("expected source trace accepted");
    const claim = claimSourceCollectTrace(db, accepted.traceId, now);
    if (!claim) throw new Error("expected source trace claim");
    const rawRoot = join(process.env.DATA_DIR!, "raw");
    mkdirSync(rawRoot, { recursive: true });
    chmodSync(rawRoot, 0o500);
    try {
      await expect(collectSource(db, sourcePod, { traceClaim: claim })).rejects.toThrow();
    } finally {
      chmodSync(rawRoot, 0o700);
    }
    const row = db.prepare("SELECT id,reader_eligible FROM content_item WHERE url=?").get("https://example.test/raw-write-failure") as { id: string; reader_eligible: number };
    expect(row.reader_eligible).toBe(0);
    expect(getContentItem(db, row.id)).toBeNull();
    expect(checkReachability({ content_item_id: row.id, quote: "body" }, new Map()).reachability).toBe("fail");
    expect(listContentForTopic(db, "t1")).not.toContainEqual(expect.objectContaining({ id: row.id }));
    expect(db.prepare("SELECT status FROM generation_effect WHERE raw_content_id=?").get(row.id)).toEqual({ status: "unknown" });
    const event = db.prepare("SELECT output_refs,metrics FROM generation_event WHERE trace_id=? AND stage='normalize' AND event_type='failed'")
      .get(accepted.traceId) as { output_refs: string; metrics: string };
    expect(JSON.parse(event.output_refs)).toEqual([expect.objectContaining({ locator: { kind: "id", id: row.id } })]);
    expect(JSON.parse(event.metrics)).toMatchObject({
      committed_output_ref_count: 0,
      rolled_back_output_ref_count: 0,
      unknown_output_ref_count: 1,
    });
  });

  it("crash after the ContentItem/intent transaction is recorded as an unknown, non-reader output", async () => {
    const now = new Date();
    raws.value = [{ ...mkRaw("https://example.test/raw-crash", "body"), raw: "original raw payload" }];
    const accepted = createScheduledSourceCollectTrace(db, { sourceId: sourcePod.id, now });
    if (accepted.kind !== "accepted") throw new Error("expected source trace accepted");
    const claim = claimSourceCollectTrace(db, accepted.traceId, now);
    if (!claim) throw new Error("expected source trace claim");
    const writer = vi.spyOn(rawArchive, "writePlannedRawArchive").mockImplementationOnce(() => {
      throw new Error("injected_crash_after_intent_commit");
    });
    try {
      await expect(collectSource(db, sourcePod, { traceClaim: claim })).rejects.toThrow("injected_crash_after_intent_commit");
    } finally {
      writer.mockRestore();
    }
    const row = db.prepare("SELECT id,reader_eligible FROM content_item WHERE url=?").get("https://example.test/raw-crash") as { id: string; reader_eligible: number };
    expect(row.reader_eligible).toBe(0);
    expect(getContentItem(db, row.id)).toBeNull();
    expect(db.prepare("SELECT status FROM generation_effect WHERE raw_content_id=?").get(row.id)).toEqual({ status: "unknown" });
    const event = db.prepare("SELECT output_refs,metrics FROM generation_event WHERE trace_id=? AND stage='normalize' AND event_type='failed'")
      .get(accepted.traceId) as { output_refs: string; metrics: string };
    expect(JSON.parse(event.output_refs)).toEqual([expect.objectContaining({ locator: { kind: "id", id: row.id } })]);
    expect(JSON.parse(event.metrics)).toMatchObject({ committed_output_ref_count: 0, rolled_back_output_ref_count: 0, unknown_output_ref_count: 1 });
  });
});
