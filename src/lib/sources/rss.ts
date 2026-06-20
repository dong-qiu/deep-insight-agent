/** RSS 2.0 + Atom 适配器；抓取前查 robots.txt。Source.endpoint = feed URL。 */
import type { Source } from "../types.js";
import { stripTranscript } from "./normalize.js";
import { UA, fetchRobots, isAllowed } from "./robots.js";
import { readTextCapped, safeFetch } from "./safe-fetch.js";
import type { RawItem } from "./types.js";
import { asArray, text, xml } from "./xml.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** <podcast:transcript> 格式优先级：纯文本 > HTML > 字幕（vtt/srt）；未知 MIME 排最后。 */
const TRANSCRIPT_MIME_RANK: Record<string, number> = {
  "text/plain": 0,
  "text/html": 1,
  "text/vtt": 2,
  "application/x-subrip": 3,
  "text/srt": 3,
};
function mimeRank(type: unknown): number {
  const t = String(type ?? "").toLowerCase().trim();
  return t in TRANSCRIPT_MIME_RANK ? TRANSCRIPT_MIME_RANK[t] : 99;
}
/** 从 <podcast:transcript>（可多个）选最佳转写 URL：按 MIME 优先级选，跳过 rel="captions"
 *  （字幕≠全文转写）；无候选返 undefined。fast-xml-parser 把属性解析为 @_url/@_type/@_rel。 */
function pickTranscriptUrl(node: any): string | undefined {
  const tags = asArray<any>(node).filter((t) => t && t["@_url"] && t["@_rel"] !== "captions");
  if (!tags.length) return undefined;
  tags.sort((a, b) => mimeRank(a["@_type"]) - mimeRank(b["@_type"]));
  return text(tags[0]["@_url"]) || undefined;
}

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
      transcript_url: pickTranscriptUrl(it["podcast:transcript"]),
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
        transcript_url: pickTranscriptUrl(e["podcast:transcript"]),
        raw: JSON.stringify(e),
      };
    });
  }

  return [];
}

/** 单次抓取保留的条目上限（MVP 只消费增量；防 OpenAI/播客等全历史 backlog 一次灌库淹没相关内容）。
 *  RSS 惯例为新到在前，取前 N 即最近 N 条；env RSS_MAX_ITEMS 可覆盖。 */
export const RSS_MAX_ITEMS = Number(process.env.RSS_MAX_ITEMS) || 50;

/** 播客转写抓取开关（ADR-0007）：默认关——关时 transcript_url 已解析但不抓，行为与接入前一致。
 *  开启（=1/true）后由 **collector**（去重后、只对新 url）抓转写——见 collector.ts（B族：6a）。
 *  调用时读 env（非模块加载常量）：便于运行期切换 + 单测两态。 */
export function transcriptFetchEnabled(): boolean {
  return process.env.TRANSCRIPT_FETCH === "1" || process.env.TRANSCRIPT_FETCH === "true";
}

export async function fetchRss(source: Source): Promise<RawItem[]> {
  const { origin, pathname } = new URL(source.endpoint);
  const rules = await fetchRobots(origin);
  if (!isAllowed(rules, pathname)) throw new Error(`robots.txt 禁止抓取：${source.endpoint}`);
  const res = await safeFetch(source.endpoint, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`rss fetch ${res.status}：${source.endpoint}`);
  // 6a：fetchRss 只解析（含 transcript_url）、**不抓转写**——抓取移到 collector 去重后、只对新 url 抓
  // （B族：避免每轮全抓 50 集，且根除 show_notes→transcript 原地改 body 的 Major6）。
  return parseRss(await readTextCapped(res)).slice(0, RSS_MAX_ITEMS);
}

/** 抓取并清洗单集转写稿：对其 origin **单独**查 robots（与 feed 常不同源，评审 Major 5）+ SSRF 安全出网
 *  + 大小封顶 + VTT/SRT 噪声清洗。任何失败（robots 禁止 / 非 2xx / 网络 / 超限 / 清洗后空）返 null。
 *  由 collector 在去重后对**新 url** 调用（6a）。 */
export async function fetchTranscript(url: string): Promise<string | null> {
  try {
    const { origin, pathname } = new URL(url);
    const rules = await fetchRobots(origin);
    if (!isAllowed(rules, pathname)) return null;
    const res = await safeFetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) return null;
    return stripTranscript(await readTextCapped(res)) || null;
  } catch {
    return null;
  }
}
