/** RSS 2.0 + Atom 适配器；抓取前查 robots.txt。Source.endpoint = feed URL。 */
import type { Source } from "../types.js";
import { extractCiteTranscript, extractHtmlTranscript, stripTranscript } from "./normalize.js";
import { stableEvidenceUrl } from "./podcast-evidence.js";
import { UA, fetchRobots, isAllowed } from "./robots.js";
import { MAX_RESPONSE_BYTES, ResponseSizeLimitError, fetchWithRetry, readTextCapped, safeFetch } from "./safe-fetch.js";
import type { PodcastProgramPageFetchResult, RawItem, TranscriptFetchResult } from "./types.js";
import { asArray, text, xml } from "./xml.js";

/** Thrown by a source-level request gate once its shared acquisition deadline is exhausted. */
export class PodcastRequestBudgetError extends Error {
  constructor() { super("podcast_request_budget_exhausted"); this.name = "PodcastRequestBudgetError"; }
}

type PodcastFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  /** Applied before both robots and payload transport by policy-aware callers. */
  beforeRequest?: (url: string) => Promise<void>;
};

/** The acquisition byte cap covers every downloaded body for an episode, including robots.
 * The successful result's `bytes` therefore records the full transport total, not just the
 * archive payload. */
function remainingTransportBytes(maxBytes: number, robotsBytes: number): number {
  const remaining = maxBytes - robotsBytes;
  if (remaining <= 0) throw new ResponseSizeLimitError(maxBytes, 0);
  return remaining;
}

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

/** Podcast classification relies exclusively on feed metadata. Newsletter RSS entries may have
 * long bodies or links, but remain generic articles unless a podcast namespace/iTunes marker or
 * an audio enclosure is present. */
function isPodcastEpisode(item: any, links: any[] = []): boolean {
  if (item["podcast:transcript"] || item["itunes:episode"] !== undefined || item["itunes:duration"] !== undefined
    || item["itunes:season"] !== undefined || item["itunes:explicit"] !== undefined || item["itunes:episodeType"] !== undefined) return true;
  const enclosures = [...asArray<any>(item.enclosure), ...links.filter((link) => link?.["@_rel"] === "enclosure")];
  return enclosures.some((entry) => /^audio\//i.test(String(entry?.["@_type"] ?? entry?.type ?? "")));
}

function podcastEpisodeType(item: any): "full" | "trailer" | "bonus" | undefined {
  const value = text(item["itunes:episodeType"]).trim().toLowerCase();
  return value === "full" || value === "trailer" || value === "bonus" ? value : undefined;
}

/** 把条目 URL 按 feed base 归一为绝对 URL（ADR-0008 决定⑤）：部分 feed 给**相对** link（如 `/post/1`），
 *  旧版原样返回 → 下游 `new URL(url)` 抛异常 → collector 静默丢条目。`new URL(raw, base)`：raw 已绝对则原样、
 *  相对则按 feed base 解析。base 缺省或解析失败时——绝对 http(s) 保留、其余丢弃（不灌非法 url）。 */
function resolveUrl(raw: string, base?: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw, base);
    // 只收 http(s)——非 http scheme（tag:/urn:/mailto:/javascript:）虽是合法 URL 不会 throw，但不是文章链接，丢弃。
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return /^https?:\/\//i.test(raw) ? raw : "";
  }
}

/** 取 RSS 2.0 条目 URL：优先 <link>（相对则按 base 归一）；缺省回退 <guid>。RSS 2.0 的 guid 默认
 *  isPermaLink=true 即文章永久链接——部分 feed（如安全客 api.anquanke.com）只给 <guid> 不给 <link>，
 *  旧版只读 link 导致 url 为空、条目被 collector 丢弃。仅当 guid 是 http(s) 且未显式 isPermaLink="false" 才用。 */
function itemUrl(it: any, base?: string): string {
  const link = text(it.link).trim();
  if (link) return resolveUrl(link, base);
  const guid = it.guid;
  if (guid && typeof guid === "object" && guid["@_isPermaLink"] === "false") return ""; // 显式非永久链接 = 仅作 id
  const g = text(guid).trim();
  return /^https?:\/\//i.test(g) ? g : "";
}

/** 解析 feed → RawItem[]。`baseUrl`=feed 自身 URL（source.endpoint），用于把相对条目链接归一为绝对（决定⑤）；
 *  缺省时仅绝对 URL 可用（单测/旧调用方零影响）。 */
/** 截断的 feed 良构化：readTextCapped(truncate) 会切在条目/CDATA 中间，fast-xml-parser 直接 parse 会抛
 *  （如 "CDATA is not closed"）。按根类型裁到**最后一个完整** </entry>|</item> 并补根闭合标签，使前面的
 *  完整条目可解析（新条在前 → 留最新数条）。无任何完整条目（单条 >8MB）或认不出根 → 返 null（不可救）。 */
export function repairTruncatedFeed(feedXml: string): string | null {
  // 根类型按**最先出现**的根标签判定（真根在所有内容之前；用 [\s>] 收边避免 <feedburner 等误配，
  // 防正文/CDATA 里的字面 <feed>/<rss> 把 RSS 误判成 Atom）。
  const iFeed = feedXml.search(/<feed[\s>]/i);
  const iRss = feedXml.search(/<rss[\s>]/i);
  let closeTag: string;
  let suffix: string;
  if (iFeed >= 0 && (iRss < 0 || iFeed < iRss)) {
    closeTag = "</entry>";
    suffix = "</feed>";
  } else if (iRss >= 0) {
    closeTag = "</item>";
    suffix = "</channel></rss>";
  } else {
    return null;
  }
  // 从尾向前找「落在 CDATA 之外」的最后一个完整闭合标签：截断尾条的 CDATA 里可能含字面 </entry>/</item>，
  // 在未闭合 CDATA 内切会留下坏 XML（修后二次 parse 仍抛）。以 candidate 内 <![CDATA[ 与 ]]> 是否配平判定。
  for (let from = feedXml.length, tries = 0; tries < 64; tries++) {
    const i = feedXml.lastIndexOf(closeTag, from - 1);
    if (i < 0) return null;
    const candidate = feedXml.slice(0, i + closeTag.length);
    const opens = (candidate.match(/<!\[CDATA\[/g) || []).length;
    const closes = (candidate.match(/\]\]>/g) || []).length;
    if (opens === closes) return candidate + suffix; // 该闭合标签在 CDATA 之外 = 结构性边界
    from = i; // 落在未闭合 CDATA 内 → 继续往前找
  }
  return null;
}

export function parseRss(feedXml: string, baseUrl?: string): RawItem[] {
  let doc: any;
  try {
    doc = xml.parse(feedXml);
  } catch (e) {
    // 截断导致的 XML 不良构：裁到最后完整条目 + 补根闭合后再解析一次；无可挽救 → 照抛原错（真损坏保持可见）。
    const repaired = repairTruncatedFeed(feedXml);
    if (repaired === null) throw e;
    doc = xml.parse(repaired);
  }

  // RSS 2.0
  if (doc?.rss?.channel) {
    return asArray<any>(doc.rss.channel.item).map((it): RawItem => {
      const podcastEpisode = isPodcastEpisode(it);
      const episodeType = podcastEpisodeType(it);
      return {
      url: itemUrl(it, baseUrl),
      title: text(it.title).replace(/\s+/g, " ").trim(),
      author: it.author ? text(it.author) : it["dc:creator"] ? text(it["dc:creator"]) : null,
      published_at: it.pubDate ? text(it.pubDate) : null,
      body: text(it["content:encoded"] ?? it.description).trim(),
      ...(podcastEpisode ? { body_kind: "show_notes" as const, is_podcast_episode: true, ...(episodeType ? { podcast_episode_type: episodeType } : {}) } : {}),
      transcript_url: pickTranscriptUrl(it["podcast:transcript"]),
      raw: JSON.stringify(it),
      };
    });
  }

  // Atom
  if (doc?.feed) {
    return asArray<any>(doc.feed.entry).map((e): RawItem => {
      const links = asArray<any>(e.link);
      const alt = links.find((l) => l["@_rel"] === "alternate")?.["@_href"] ?? links[0]?.["@_href"];
      const podcastEpisode = isPodcastEpisode(e, links);
      const episodeType = podcastEpisodeType(e);
      return {
        url: resolveUrl(text(alt), baseUrl) || text(e.id),
        title: text(e.title).replace(/\s+/g, " ").trim(),
        author: e.author ? text(asArray<any>(e.author)[0]?.name ?? e.author) || null : null,
        published_at: text(e.published || e.updated) || null,
        body: text(e.content ?? e.summary).trim(),
        ...(podcastEpisode ? { body_kind: "show_notes" as const, is_podcast_episode: true, ...(episodeType ? { podcast_episode_type: episodeType } : {}) } : {}),
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

/** 播客转写的全局应急允许门：默认关。它不能让任何源自行 opt-in；后续 policy-aware
 *  acquisition/shadow worker 还必须同时通过源策略、预筛、配额和事实记录门。调用时读 env
 *  （非模块加载常量），便于运行期熔断和单测两态。 */
export function transcriptFetchEnabled(): boolean {
  return process.env.TRANSCRIPT_FETCH === "1" || process.env.TRANSCRIPT_FETCH === "true";
}

export async function fetchRss(source: Source): Promise<RawItem[]> {
  const { origin, pathname } = new URL(source.endpoint);
  const rules = await fetchRobots(origin);
  if (!isAllowed(rules, pathname)) throw new Error(`robots.txt 禁止抓取：${source.endpoint}`);
  const res = await fetchWithRetry(source.endpoint, { headers: { "user-agent": UA } }); // 切片3a：feed 瞬时失败退避重试
  if (!res.ok) throw new Error(`rss fetch ${res.status}：${source.endpoint}`);
  // fetchRss 只解析（含 transcript_url）、**不抓转写**。后续 policy-aware acquisition/shadow
  // worker 会在源策略、预筛和配额门之后处理候选，避免每轮全抓 feed，并保持既有 body_kind 不变。
  // 决定⑤：传 feed URL 作 base，把相对条目链接归一为绝对（防相对 link → 下游 new URL 抛错丢条目）。
  // truncate=true：超大 feed（Project Zero 13MB / Latent Space podcast 12.6MB 等）取前 8MB 而非整轮失败。
  // 注意：fast-xml-parser 对截断串会抛（如 CDATA 未闭合）——由 parseRss 的 repairTruncatedFeed 兜底裁到
  // 最后完整条目 + 补根闭合再解析（新条在前 → 留最新数条）。仅字节截断不足以良构，二者配套缺一不可。
  const feedXml = await readTextCapped(res, MAX_RESPONSE_BYTES, { truncate: true, label: source.endpoint });
  return parseRss(feedXml, source.endpoint).slice(0, RSS_MAX_ITEMS);
}

/** 抓取并清洗单集转写稿：对其 origin **单独**查 robots（与 feed 常不同源）+ SSRF 安全出网
 *  + 大小封顶 + VTT/SRT 噪声清洗。它返回结构化 TranscriptFetchResult；当前生产 collector
 *  不调用它，后续 policy-aware acquisition/shadow worker 会在所有采集门通过后接入。 */
export async function fetchTranscript(
  url: string,
  opts: PodcastFetchOptions = {},
): Promise<TranscriptFetchResult> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 15_000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let robotsBytes = 0;
  let readingPayload = false;
  let stableUrl = "";
  try {
    stableUrl = stableEvidenceUrl(url);
    const { origin, pathname } = new URL(url);
    const rules = await fetchRobots(origin, UA, {
      timeoutMs: remaining(), maxBytes, beforeRequest: opts.beforeRequest,
      onBytes: (bytes) => { robotsBytes += bytes; },
    });
    if (!isAllowed(rules, pathname)) {
      return { outcome: "robots_denied", stable_url: stableUrl, bytes: robotsBytes || null, duration_ms: Date.now() - started, reason_code: "robots_denied" };
    }
    const payloadCap = remainingTransportBytes(maxBytes, robotsBytes);
    const res = await safeFetch(url, { headers: { "user-agent": UA }, timeoutMs: remaining(), beforeRequest: opts.beforeRequest });
    if (!res.ok) {
      return { outcome: "http_error", stable_url: stableUrl, bytes: robotsBytes || null, duration_ms: Date.now() - started, reason_code: `http_${res.status}` };
    }
    readingPayload = true;
    const raw = await readTextCapped(res, payloadCap);
    const payloadBytes = Buffer.byteLength(raw, "utf8");
    // 结构化 HTML 转写页走专用抽取（抽空 → null，不灌垃圾）：Lex 式 .ts-text（6d）、Changelog 式 <cite>/<p>
    // （2026-06-26）；其余 VTT/SRT/纯文本走 stripTranscript。
    const cleaned = /class="[^"]*\bts-text\b/i.test(raw)
      ? extractHtmlTranscript(raw)
      : /<cite\b[^>]*>/i.test(raw) && /<\/p>/i.test(raw)
        ? extractCiteTranscript(raw)
        : stripTranscript(raw);
    if (!cleaned) {
      return { outcome: "parse_empty", stable_url: stableUrl, bytes: robotsBytes + payloadBytes, duration_ms: Date.now() - started, reason_code: "cleaned_body_empty" };
    }
    return {
      outcome: "success", stable_url: stableUrl, raw_payload: raw, cleaned_body: cleaned,
      bytes: robotsBytes + payloadBytes, duration_ms: Date.now() - started,
      content_type: res.headers?.get("content-type") ?? null,
    };
  } catch (error) {
    // Keep categories stable for acquisition facts; error messages are not a durable API.
    const outcome = error instanceof ResponseSizeLimitError ? "size_limited"
      : error instanceof PodcastRequestBudgetError ? "timeout"
      : error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "timeout" : "transient_error";
    return {
      outcome, stable_url: stableUrl ?? "", bytes: error instanceof ResponseSizeLimitError
        ? robotsBytes + (readingPayload ? error.bytesRead : 0) : robotsBytes || null, duration_ms: Date.now() - started,
      reason_code: outcome === "size_limited" ? "response_size_limit" : error instanceof PodcastRequestBudgetError
        ? "source_timeout_budget_exhausted" : outcome === "timeout" ? "request_timeout" : "request_error",
    };
  }
}

/** Fetch the public episode/program page as evidence, independently applying robots, SSRF and
 * streaming limits. A transcript sample is evidence-complete only when this succeeds too. */
export async function fetchPodcastProgramPage(
  url: string,
  opts: PodcastFetchOptions = {},
): Promise<PodcastProgramPageFetchResult> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 15_000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let robotsBytes = 0;
  let readingPayload = false;
  let stableUrl = "";
  try {
    stableUrl = stableEvidenceUrl(url);
    const { origin, pathname } = new URL(url);
    const rules = await fetchRobots(origin, UA, {
      timeoutMs: remaining(), maxBytes, beforeRequest: opts.beforeRequest,
      onBytes: (bytes) => { robotsBytes += bytes; },
    });
    if (!isAllowed(rules, pathname)) {
      return { outcome: "robots_denied", stable_url: stableUrl, bytes: robotsBytes || null, duration_ms: Date.now() - started, reason_code: "robots_denied" };
    }
    const payloadCap = remainingTransportBytes(maxBytes, robotsBytes);
    const res = await safeFetch(url, { headers: { "user-agent": UA }, timeoutMs: remaining(), beforeRequest: opts.beforeRequest });
    if (!res.ok) {
      return { outcome: "http_error", stable_url: stableUrl, bytes: robotsBytes || null, duration_ms: Date.now() - started, reason_code: `http_${res.status}` };
    }
    readingPayload = true;
    const raw = await readTextCapped(res, payloadCap);
    const payloadBytes = Buffer.byteLength(raw, "utf8");
    return {
      outcome: "success", stable_url: stableUrl, raw_payload: raw,
      bytes: robotsBytes + payloadBytes, duration_ms: Date.now() - started,
      content_type: res.headers?.get("content-type") ?? null,
    };
  } catch (error) {
    const outcome = error instanceof ResponseSizeLimitError ? "size_limited"
      : error instanceof PodcastRequestBudgetError ? "timeout"
      : error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "timeout" : "transient_error";
    return {
      outcome, stable_url: stableUrl, bytes: error instanceof ResponseSizeLimitError
        ? robotsBytes + (readingPayload ? error.bytesRead : 0) : robotsBytes || null, duration_ms: Date.now() - started,
      reason_code: outcome === "size_limited" ? "response_size_limit" : error instanceof PodcastRequestBudgetError
        ? "source_timeout_budget_exhausted" : outcome === "timeout" ? "request_timeout" : "request_error",
    };
  }
}
