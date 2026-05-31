/** RawItem → ContentItem 的归一化：URL 规范化、内容指纹、语言检测、稳定 id。纯函数，可无 key 单测。 */
import { createHash } from "node:crypto";
import type { ContentItem, Language, Source } from "../types.js";
import type { RawItem } from "./types.js";

const TRACKING = /^(utm_|ref$|fbclid$|gclid$|mc_|spm$)/i;

/** 单条 ContentItem 正文字符上限（data-collection AC9）：超限截断并标 fetch_status=partial，
 *  防异常大正文撑爆库 / 拖垮分析 token；下游可据 partial 决定是否回源补全。 */
export const MAX_BODY_CHARS = 50_000;

/** 去 fragment / 跟踪参数 / 末尾斜杠，host 小写。解析失败则原样 trim。 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

const DECIMAL_ENTITY = /&#(\d+);/g;
const HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;
function codePoint(n: number): string {
  try {
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** 剥 HTML 标签 + 解码常见实体 → 纯文本。RSS content:encoded / 网页抓取常把正文裹在 <strong>/<a> 里，
 *  尤以**数字/具名实体被加粗或做成链接**（因其重要）。模型引用时自然剥标签，致 quote 与含标签的 body 逐字
 *  不匹配 → repairQuote 在首个标签处截断，恰好砍掉那个被强调的数字 → 引用覆盖不足（#14 类根因）。
 *  在归一层统一清洗，使 body 为干净文本，让模型 quote 直接逐字可达。
 *  仅匹配字母起头的标签（<\/?[a-zA-Z]…>），保留正文里的 "a < b" 等不等式；幂等（清洗后再清洗无变化）。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ") // 整段丢弃脚本/样式
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|ul|ol|blockquote|section|article|table|thead|tbody|figure|figcaption|pre|hr)\b[^>]*>/gi, "\n") // 块级 → 换行，防跨块粘连
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // 行内标签（<strong>/<a>…）→ 删除，使 "处理<strong>over" → "处理over"
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // 常见印刷/排版命名实体——rep_54ed154e 抽样审计发现 body 残留 &rsquo;/&rdquo;
    // 致 substring 与模型 ASCII quote 永不匹配（2/13 blocked 的直接根因）。补齐：
    .replace(/&lsquo;/gi, "‘")  // '
    .replace(/&rsquo;/gi, "’")  // '
    .replace(/&ldquo;/gi, "“")  // "
    .replace(/&rdquo;/gi, "”")  // "
    .replace(/&ndash;/gi, "–")  // –
    .replace(/&mdash;/gi, "—")  // —
    .replace(/&hellip;/gi, "…") // …
    .replace(DECIMAL_ENTITY, (_, n) => codePoint(Number(n)))
    .replace(HEX_ENTITY, (_, n) => codePoint(parseInt(n, 16)));
}

export function normalizeBody(body: string): string {
  return stripHtml(body).replace(/\s+/g, " ").trim();
}

/** 内容指纹 = 规范化 body 的 sha256，用于同 URL 内容更新检测。 */
export function contentHash(body: string): string {
  return createHash("sha256").update(normalizeBody(body)).digest("hex");
}

/** 轻量语言检测：按 CJK / 拉丁字符占比。 */
export function detectLanguage(text: string): Language {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0) return "en";
  if (latin === 0) return "zh";
  const ratio = cjk / (cjk + latin);
  return ratio > 0.7 ? "zh" : ratio < 0.15 ? "en" : "mixed";
}

/** 稳定 id：仅按规范化 URL 取哈希 —— 同 URL 内容更新时 id 不变（data-collection AC2「原地更新、id 不变」）。 */
export function contentItemId(url: string): string {
  return `ci_${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;
}

/** raw_ref 由 collector 归档后回填；topic_ids 继承 Source（源级粒度，见 architecture）。
 *  正文超 MAX_BODY_CHARS 则截断并标 partial（AC9）；指纹按截断后正文计（去重判定一致）。 */
export function rawToContentItem(raw: RawItem, source: Source, fetchedAt: string): ContentItem {
  const full = normalizeBody(raw.body);
  const truncated = full.length > MAX_BODY_CHARS;
  const body = truncated ? full.slice(0, MAX_BODY_CHARS) : full;
  const hash = contentHash(body);
  const url = normalizeUrl(raw.url);
  return {
    id: contentItemId(url),
    source_id: source.id,
    url,
    title: raw.title.trim() || "(untitled)",
    author: raw.author,
    published_at: raw.published_at,
    fetched_at: fetchedAt,
    language: detectLanguage(`${raw.title} ${body}`),
    topic_ids: source.topic_ids,
    tags: [],
    body,
    raw_ref: "",
    content_hash: hash,
    fetch_status: truncated ? "partial" : "ok",
  };
}
