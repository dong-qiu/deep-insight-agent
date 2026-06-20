/** 文章全文抓取（标题党 RSS 的补全）：部分 feed（如安全客 api.anquanke.com/data/v1/rss）只给
 *  标题 + 链接、`<description>` 为空，直接采集会得空正文条目被 collector 丢弃。本模块按条目 URL 抓
 *  文章页 + 抽正文容器，补成可分析的 body。
 *
 *  与 rss.ts 的 fetchTranscript 同构（按 origin 单独查 robots + SSRF 安全出网 + 大小封顶），差别是
 *  「抽正文容器」而非「清洗字幕」。**抓前去重由 collector 负责**（只对未见过的 URL 调本函数），避免每轮
 *  cron 重抓已采文章 hammer 源（吸取 transcript 串行全抓的教训）。 */
import { normalizeBody } from "./normalize.js";
import { UA, fetchRobots, isAllowed } from "./robots.js";
import { readTextCapped, safeFetch } from "./safe-fetch.js";

/** 全文抓取开关（默认关——关时空正文条目维持现状被跳过，对既有源零行为变化）。
 *  开（=1/true）后 collector 对空正文条目按 URL 抓文章页补全。运行期读 env，便于切换 + 单测两态。 */
export function articleFetchEnabled(): boolean {
  return process.env.ARTICLE_FETCH === "1" || process.env.ARTICLE_FETCH === "true";
}

/** 抽取后纯文本下限：低于此视为没抽到真正文（抽到空壳/导航/版权条），返 null 而非灌垃圾。 */
const MIN_ARTICLE_CHARS = 200;

/** 常见正文容器定位（按特异性从高到低试，先命中先用）：id 带 article/post/content 最可靠，
 *  其次具名正文 class，再次语义 <article>，最后兜底泛 content class。匹配的是**开标签**，
 *  真正截取靠下面同名标签深度配对（正则配不了嵌套）。 */
const CONTAINER_PATTERNS: RegExp[] = [
  /<(article|main|div|section)\b[^>]*\bid\s*=\s*["'][^"']*(?:js-article|article|post|content|main-content)[^"']*["'][^>]*>/i,
  /<(article|main|div|section)\b[^>]*\bclass\s*=\s*["'][^"']*(?:article-content|article-body|articleContent|post-content|entry-content|markdown-body|markdown|rich_media_content)[^"']*["'][^>]*>/i,
  /<article\b[^>]*>/i,
  /<(div|main|section)\b[^>]*\bclass\s*=\s*["'][^"']*content[^"']*["'][^>]*>/i,
];

/** 从整页 HTML 抽正文容器子树（返回 HTML 片段，下游 rawToContentItem→normalizeBody 统一剥标签）。
 *  找不到容器则回退 <body> 内容；都没有返回清洗后的整页。纯正则 + 深度计数，无 DOM 依赖（沿用本项目极简风）。 */
export function extractArticleHtml(html: string): string {
  // 先整段丢 script/style/noscript/注释——否则其中的 "<div>" 字符串会干扰容器配对计数
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  let open: RegExpMatchArray | null = null;
  for (const re of CONTAINER_PATTERNS) {
    open = cleaned.match(re);
    if (open && open.index != null) break;
    open = null;
  }
  if (!open || open.index == null) {
    const body = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    return body ? body[1] : cleaned;
  }

  const tag = open[1] ? open[1].toLowerCase() : "article"; // <article> 无捕获组 → 标签即 article
  const start = open.index + open[0].length;
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let end = cleaned.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[0][1] === "/") {
      depth -= 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    } else {
      depth += 1;
    }
  }
  return cleaned.slice(start, end);
}

/** 按文章 URL 抓全文：origin 单独查 robots（文章页常与 feed 不同源）+ SSRF 安全出网 + 大小封顶 + 抽正文。
 *  失败（robots 禁止 / 非 2xx / 非 HTML / 网络 / 抽取后过短）一律返 null —— collector 视为抽取失败、跳过该条。 */
export async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const { origin, pathname } = new URL(url);
    const rules = await fetchRobots(origin);
    if (!isAllowed(rules, pathname)) return null;
    const res = await safeFetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) return null;
    if (!/html/i.test(res.headers.get("content-type") ?? "")) return null; // 只处理 HTML 页
    const main = extractArticleHtml(await readTextCapped(res));
    if (normalizeBody(main).length < MIN_ARTICLE_CHARS) return null; // 抽取后过短 = 没抽到真正文
    return main; // HTML 片段，下游统一 normalizeBody 剥标签
  } catch {
    return null;
  }
}
