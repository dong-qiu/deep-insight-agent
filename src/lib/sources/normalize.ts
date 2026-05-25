/** RawItem → ContentItem 的归一化：URL 规范化、内容指纹、语言检测、稳定 id。纯函数，可无 key 单测。 */
import { createHash } from "node:crypto";
import type { ContentItem, Language, Source } from "../types.js";
import type { RawItem } from "./types.js";

const TRACKING = /^(utm_|ref$|fbclid$|gclid$|mc_|spm$)/i;

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

export function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
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

/** raw_ref 由 collector 归档后回填；topic_ids 继承 Source（源级粒度，见 architecture）。 */
export function rawToContentItem(raw: RawItem, source: Source, fetchedAt: string): ContentItem {
  const body = normalizeBody(raw.body);
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
    fetch_status: "ok",
  };
}
