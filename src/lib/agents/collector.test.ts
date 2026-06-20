/** collector 全文回填编排（标题党 RSS）：空正文条目在 ARTICLE_FETCH 开 + URL 未见过时抓全文补全，
 *  已采过的 URL 不重抓（抓前去重，避免每轮 cron hammer 源）；开关关时维持现状（空正文跳过）。
 *  mock fetchFromSource（喂 raw）+ fetchArticleBody（受控全文），用 in-memory DB 跑真实 collectSource。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, openDb } from "../db/index.js";
import { normalizeUrl } from "../sources/normalize.js";
import type { RawItem } from "../sources/types.js";

const { raws, article } = vi.hoisted(() => ({
  raws: { value: [] as RawItem[] },
  article: { fn: vi.fn(async (_url: string) => null as string | null) },
}));

vi.mock("../sources/index.js", () => ({
  fetchFromSource: vi.fn(async () => raws.value),
}));
vi.mock("../sources/article.js", () => ({
  articleFetchEnabled: vi.fn(() => process.env.ARTICLE_FETCH === "1"),
  fetchArticleBody: (url: string) => article.fn(url),
}));

const { collectSource } = await import("./collector.js");

const source = {
  id: "s_anq", name: "安全客", type: "rss" as const, endpoint: "https://api.anquanke.com/data/v1/rss",
  industry: "ai-security" as const, topic_ids: ["t_sec"], fetch_interval: "1h", backfill: null, enabled: true,
};

const titleOnly = (url: string): RawItem => ({
  url, title: "某高危漏洞", author: "安全客", published_at: "2026-06-18 20:00:10", body: "", raw: "{}",
});

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO topic (id,name,industry,language,brief_schedule) VALUES ('t_sec','安全','ai-security','zh','daily')").run();
  db.prepare(
    "INSERT INTO source (id,name,type,endpoint,industry,topic_ids,fetch_interval,enabled) VALUES (@id,@name,@type,@endpoint,@industry,@topic_ids,@fetch_interval,1)",
  ).run({ ...source, topic_ids: JSON.stringify(source.topic_ids) });
  article.fn.mockReset();
});
afterEach(() => {
  delete process.env.ARTICLE_FETCH;
  raws.value = [];
});

describe("collector 标题党 RSS 全文回填", () => {
  it("开关关：空正文条目跳过、不抓全文、不入库", async () => {
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    const r = await collectSource(db, source);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("开关开 + 新 URL：抓全文补全 → 入库（body=抓到的正文）", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue("<p>这是抓到的文章正文，足够长可分析。</p>");
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    const r = await collectSource(db, source);
    expect(article.fn).toHaveBeenCalledWith("https://www.anquanke.com/post/id/1");
    expect(r.inserted).toBe(1);
    // getContentByUrl 只返 {id,content_hash}（去重查），正文直接查列断言
    const row = db.prepare("SELECT body FROM content_item WHERE url = ?").get(normalizeUrl("https://www.anquanke.com/post/id/1")) as { body: string } | undefined;
    expect(row?.body).toContain("抓到的文章正文");
  });

  it("开关开 + 已采过该 URL（库里有正文）：不重抓、跳过", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue("<p>这是抓到的文章正文，足够长可分析。</p>");
    raws.value = [titleOnly("https://www.anquanke.com/post/id/1")];
    await collectSource(db, source); // 第一轮：抓 + 入库
    article.fn.mockClear();
    const r2 = await collectSource(db, source); // 第二轮：同 URL
    expect(article.fn).not.toHaveBeenCalled(); // 抓前去重 → 不重抓
    expect(r2.skipped).toBe(1);
    expect(r2.inserted).toBe(0);
  });

  it("开关开 + 抓取失败（返 null）：跳过、不入库", async () => {
    process.env.ARTICLE_FETCH = "1";
    article.fn.mockResolvedValue(null);
    raws.value = [titleOnly("https://www.anquanke.com/post/id/9")];
    const r = await collectSource(db, source);
    expect(article.fn).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("单轮全文抓取上限：超过 ARTICLE_FETCH_MAX_PER_RUN 的条目本轮跳过、留下轮", async () => {
    process.env.ARTICLE_FETCH = "1";
    process.env.ARTICLE_FETCH_MAX_PER_RUN = "2";
    article.fn.mockResolvedValue("<p>足够长的文章正文内容可供分析使用。</p>");
    raws.value = [1, 2, 3, 4].map((n) => titleOnly(`https://www.anquanke.com/post/id/${n}`));
    const r = await collectSource(db, source);
    expect(article.fn).toHaveBeenCalledTimes(2); // 上限 2，只抓前两条
    expect(r.inserted).toBe(2);
    expect(r.skipped).toBe(2); // 后两条本轮跳过
    delete process.env.ARTICLE_FETCH_MAX_PER_RUN;
  });

  it("有正文的条目不触发全文抓取（仅空正文才抓）", async () => {
    process.env.ARTICLE_FETCH = "1";
    raws.value = [{ ...titleOnly("https://x/full"), body: "feed 自带的完整正文内容，足够长。" }];
    const r = await collectSource(db, source);
    expect(article.fn).not.toHaveBeenCalled();
    expect(r.inserted).toBe(1);
  });
});
