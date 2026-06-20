/** RawItem → ContentItem 的归一化：URL 规范化、内容指纹、语言检测、稳定 id。纯函数，可无 key 单测。 */
import { createHash } from "node:crypto";
import type { ContentItem, Language, Source } from "../types.js";
import { parsePublishedAt } from "./parse-date.js";
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

/** VTT/SRT cue 时间轴行：**行首时间戳** + `-->`（HH:)?MM:SS(.|,mmm)? --> …。
 *  要求行首时间戳，避免把口播里的 "A --> B" / 含箭头代码整行误删（评审 M2）。 */
const CUE_TIMELINE = /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-->/;

/** 清洗转写稿（VTT / SRT / 纯文本）→ 干净正文（ADR-0007 切片2）：
 *  剥 WEBVTT 头、NOTE/STYLE/REGION 元数据块（延续到空行）、cue 时间轴行、SRT cue 序号（纯数字 + 后随时间轴）。
 *  **不误伤正文**：纯数字行仅在「下一行是时间轴」时才当 SRT 序号删（评审 M1）；时间轴按行首时间戳判（评审 M2）；
 *  NOTE/STYLE/REGION 按块删到空行（评审 M3）。HTML 形态转写交由下游 normalizeBody 的 stripHtml（两段清洗叠加、幂等）。
 *  保留说话人标签（如 "John: …"）：内容歧义大、剥除易误伤，analyzer 可直接消费。 */
export function stripTranscript(raw: string): string {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/); // 去 BOM
  const out: string[] = [];
  let skipBlock = false; // VTT NOTE/STYLE/REGION 块延续到空行
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) {
      skipBlock = false; // 空行结束块
      continue;
    }
    if (skipBlock) continue;
    if (/^WEBVTT/i.test(l)) continue; // VTT 头
    if (/^(NOTE|STYLE|REGION)\b/.test(l)) {
      skipBlock = true; // 块起始 → 丢到下一空行
      continue;
    }
    if (CUE_TIMELINE.test(l)) continue; // 时间轴行
    // SRT cue 序号：纯数字行且**下一非空行是时间轴**才删——否则是正文里的独立数字（口播 "2024"/"42"）。
    // 跳过中间空行（部分生成器产出 "N\n\n时间轴"）后再判，避免序号泄漏进正文。
    if (/^\d+$/.test(l)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (CUE_TIMELINE.test((lines[j] ?? "").trim())) continue;
    }
    out.push(l);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
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
    // dogfood feedback：published_at 必须归一化到 ISO 8601，否则 SQL 字典序 ≠ 时间序，
    // 导致 listContentForTopic 用 `published_at >= since` 过滤时把 RFC 2822 字符串
    // 拿来比对必然错乱。解析失败保留 null。
    published_at: parsePublishedAt(raw.published_at),
    fetched_at: fetchedAt,
    language: detectLanguage(`${raw.title} ${body}`),
    topic_ids: source.topic_ids,
    tags: [],
    body,
    body_kind: raw.body_kind ?? "article", // 适配器未标则默认 article（ADR-0007；transcript 由 rss 适配器在切片2 设）
    raw_ref: "",
    content_hash: hash,
    fetch_status: truncated ? "partial" : "ok",
  };
}
