/** RSS 2.0 + Atom 适配器；抓取前查 robots.txt。Source.endpoint = feed URL。 */
import type { Source } from "../types.js";
import { UA, fetchRobots, isAllowed } from "./robots.js";
import { readTextCapped, safeFetch } from "./safe-fetch.js";
import type { RawItem } from "./types.js";
import { asArray, text, xml } from "./xml.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseRss(feedXml: string): RawItem[] {
  const doc = xml.parse(feedXml) as any;

  // RSS 2.0
  if (doc?.rss?.channel) {
    return asArray<any>(doc.rss.channel.item).map((it): RawItem => ({
      url: text(it.link),
      title: text(it.title).replace(/\s+/g, " ").trim(),
      author: it.author ? text(it.author) : it["dc:creator"] ? text(it["dc:creator"]) : null,
      published_at: it.pubDate ? text(it.pubDate) : null,
      body: text(it["content:encoded"] ?? it.description).trim(),
      raw: JSON.stringify(it),
    }));
  }

  // Atom
  if (doc?.feed) {
    return asArray<any>(doc.feed.entry).map((e): RawItem => {
      const links = asArray<any>(e.link);
      const alt = links.find((l) => l["@_rel"] === "alternate")?.["@_href"] ?? links[0]?.["@_href"];
      return {
        url: text(alt) || text(e.id),
        title: text(e.title).replace(/\s+/g, " ").trim(),
        author: e.author ? text(asArray<any>(e.author)[0]?.name ?? e.author) || null : null,
        published_at: text(e.published || e.updated) || null,
        body: text(e.content ?? e.summary).trim(),
        raw: JSON.stringify(e),
      };
    });
  }

  return [];
}

/** 单次抓取保留的条目上限（MVP 只消费增量；防 OpenAI/播客等全历史 backlog 一次灌库淹没相关内容）。
 *  RSS 惯例为新到在前，取前 N 即最近 N 条；env RSS_MAX_ITEMS 可覆盖。 */
export const RSS_MAX_ITEMS = Number(process.env.RSS_MAX_ITEMS) || 50;

export async function fetchRss(source: Source): Promise<RawItem[]> {
  const { origin, pathname } = new URL(source.endpoint);
  const rules = await fetchRobots(origin);
  if (!isAllowed(rules, pathname)) throw new Error(`robots.txt 禁止抓取：${source.endpoint}`);
  const res = await safeFetch(source.endpoint, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`rss fetch ${res.status}：${source.endpoint}`);
  return parseRss(await readTextCapped(res)).slice(0, RSS_MAX_ITEMS);
}
