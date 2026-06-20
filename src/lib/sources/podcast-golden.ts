/** 金牌源播客适配器（ADR-0007 切片6d）：对「转写不在 feed 里、但在官网有规律 URL」的播客，
 *  在 rss 解析后做两件事——①**标题筛子**：丢掉与本源主题无关的单集（如 Lex 的物理/政治集）；
 *  ②**转写 URL 推导**：从单集页 URL 推出官网转写页 URL，交回 collector 的「只对新 url 抓」流程。
 *  按 Source.endpoint 的 host 命中注册表；未注册的源原样透传，零影响其它源。 */
import type { Source } from "../types.js";
import type { RawItem } from "./types.js";

interface GoldenAdapter {
  /** 由单集 URL 推导转写页 URL；推不出（非单集页/异常）返 undefined。 */
  transcriptUrl(item: RawItem): string | undefined;
  /** 标题筛子：true=保留、false=丢弃。省略=不筛（全保留）。 */
  titleAllowed?(title: string): boolean;
}

/** AI 时代软件工程的标题命中词（标题筛子，针对 Lex 这类选题极宽的泛播客）。
 *  逐词加词界，避免 "AI" 误中 "Ukraine/domain" 之类。命中任一即视为相关。
 *  设计取向：**宁可错收不可漏收**——错收一集顶多转写抓取失败/低价值，漏收则永久丢掉一线深访。
 *  故个别宽词（Rust/Ruby/computer）可能偶中无关标题（Rust Belt 等），为提召回有意接受。
 *  `\bA\.?I\b` **故意区分大小写**：Lex 标题里缩写恒大写 "AI/A.I."，不加 /i 可避开 "Ai 某某"（人名）误中；
 *  芯片话题靠 NVIDIA/TSMC/semiconductor/GPU 这些无歧义词覆盖，不收宽词 "chips"（fish and chips 误中）。 */
const AI_SWE_PATTERNS: RegExp[] = [
  /\bA\.?I\b/, /\bAGI\b/, /\bLLMs?\b/i, /\bGPT\b/i, /\bagent(?:s|ic)?\b/i, /\bneural\b/i,
  /machine learning/i, /deep learning/i, /\btransformers?\b/i, /\bRLHF\b/i,
  /programming/i, /\bsoftware\b/i, /\bcod(?:e|ing)\b/i, /\bcoder\b/i, /developer/i,
  /\bengineer(?:ing)?\b/i, /computer/i, /algorithms?/i, /compilers?/i, /\bdatabases?\b/i,
  /open[- ]source/i, /\blinux\b/i, /\bkernel\b/i, /\bGPUs?\b/i, /semiconductors?/i,
  /\bNVIDIA\b/i, /\bOpenAI\b/i, /\bDeepMind\b/i, /\bAnthropic\b/i, /\bClaude\b/i, /\bChatGPT\b/i,
  /\bDeepSeek\b/i, /\bxAI\b/i, /\bTSMC\b/i, /\bRuby\b/i, /\bRails\b/i, /\bPython\b/i, /\bRust\b/i,
  /\bFFmpeg\b/i, /robot(?:ics|s)?/i, /\bquantum comput/i, /cybersecurity/i, /\bhacking\b/i,
];

/** 知名 AI/CS 一线人物：标题只含嘉宾名、不含上面任何词时的兜底（如 "Sundar Pichai: CEO of Google"）。 */
const NOTABLE_GUESTS: RegExp[] = [
  /Demis Hassabis/i, /Dario Amodei/i, /Sam Altman/i, /Sundar Pichai/i, /Andrej Karpathy/i,
  /Ilya Sutskever/i, /Jensen Huang/i, /Yann LeCun/i, /Geoffrey Hinton/i, /Satya Nadella/i,
  /George Hotz/i, /John Carmack/i, /Chris Lattner/i, /Guido van Rossum/i, /Linus Torvalds/i,
];

/** 标题是否与「AI 时代的软件工程」相关：命中关键词 **或** 命中知名嘉宾。 */
export function titleMatchesAiSwe(title: string): boolean {
  return AI_SWE_PATTERNS.some((re) => re.test(title)) || NOTABLE_GUESTS.some((re) => re.test(title));
}

/** Lex Fridman：单集页 https://lexfridman.com/<slug>/ → 转写页 https://lexfridman.com/<slug>-transcript/。
 *  仅对 lexfridman.com 的**单段 slug**单集页推导（排除多级路径/非该站）。转写页存在性由 fetchTranscript
 *  实抓兜底（404/空 → 返 null → collector 维持 feed 原 description 正文，body_kind 仍 article）。 */
export function deriveLexTranscriptUrl(episodeUrl: string): string | undefined {
  try {
    const u = new URL(episodeUrl);
    if (u.hostname.replace(/^www\./, "") !== "lexfridman.com") return undefined;
    const slug = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!slug || slug.includes("/") || slug.endsWith("-transcript")) return undefined;
    return `https://lexfridman.com/${slug}-transcript/`;
  } catch {
    return undefined;
  }
}

/** 注册表：host → 适配器。新增金牌源播客只在此加一行。 */
const REGISTRY: Record<string, GoldenAdapter> = {
  "lexfridman.com": {
    transcriptUrl: (item) => deriveLexTranscriptUrl(item.url),
    titleAllowed: titleMatchesAiSwe,
  },
};

function adapterFor(source: Source): GoldenAdapter | undefined {
  try {
    return REGISTRY[new URL(source.endpoint).hostname.replace(/^www\./, "")];
  } catch {
    return undefined;
  }
}

/** 金牌源后处理：注册源才生效——先标题筛子丢离题集，再为无 transcript_url 的集推导转写 URL。
 *  非注册源（arxiv/普通 rss/已带 podcast:transcript 的播客）**原样返回**。 */
export function applyGoldenSource(source: Source, items: RawItem[]): RawItem[] {
  const adapter = adapterFor(source);
  if (!adapter) return items;
  const out: RawItem[] = [];
  for (const it of items) {
    if (adapter.titleAllowed && !adapter.titleAllowed(it.title)) continue; // 标题筛子：离题集不入库
    if (it.transcript_url) {
      out.push(it); // feed 已带转写 URL（少见但尊重），不覆盖
      continue;
    }
    const url = adapter.transcriptUrl(it);
    out.push(url ? { ...it, transcript_url: url } : it);
  }
  return out;
}
