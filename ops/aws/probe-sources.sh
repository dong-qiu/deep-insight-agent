#!/usr/bin/env bash
# 候选数据源「生产 IP 可达性 + robots 合规 + full_text 正文容器」实测（接入前门禁）。
# robots 门为 2026-06-28 补：Changelog 接入漏查 robots（probe 绕过、生产遵守 → ingest failed）的修复。
# 动机：本机 curl 200 ≠ 生产可达——AWS 新加坡出口 IP 常被 WAF/Cloudflare 整段拦
# （FreeBuf 伪 405 / Bleeping cf-challenge 的教训）。故在生产主机上、用 app 的真实 UA
# （InsightAgentBot）+ Node fetch（运行镜像 slim 无 curl，与健康检查/cron 同路径）实测。
# 正文容器抽取**忠实内联** src/lib/sources/article.ts 的 extractArticleHtml + normalize.ts 的
# stripHtml（容器里 Next standalone 已打包、无干净 import 路径；SSM 输出 ~24KB 限，无法回传 HTML
# 本地再抽）——口径对齐 ADR-0008 决定③，只回传紧凑指标。
#
# 走 SSM send-command 在容器 deep-insight-app-1 内跑 node（无需 SSH；GFW 下直连/隧道易超时）。
# 前置：本机已配 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890；aws cli 读 http_proxy/https_proxy）。
# 用法：./probe-sources.sh
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad

# 容器内自包含探测脚本（仅用 Node 20 内置 fetch + 正则，无第三方依赖）。
read -r -d '' PROBE <<'JS' || true
"use strict";
const UA = "InsightAgentBot";              // = src/lib/sources/robots.ts
const MIN_ARTICLE_CHARS = 200;             // = src/lib/sources/article.ts
const FETCH_TIMEOUT_MS = 12000;

// Tier-1 候选（与分析结论一致）：feed URL / 预期模式 / 按源容器猜测（class|id token，试多个取最优）。
const CANDIDATES = [
  { id: "src_simonwillison", name: "Simon Willison", url: "https://simonwillison.net/atom/everything/",
    mode: "full_text", guesses: ["entry", "content"] },
  { id: "src_martinfowler",  name: "Martin Fowler",  url: "https://martinfowler.com/feed.atom",
    mode: "feed",      guesses: [] },
  { id: "src_aider",         name: "Aider",          url: "https://aider.chat/feed.xml",
    mode: "full_text", guesses: ["md-content", "post-content", "content"] },
];

// ── 忠实内联：extractArticleHtml（article.ts）──────────────────────────────
function containerPattern(token) {
  const t = token.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<(article|main|div|section)\\b[^>]*\\b(?:id|class)\\s*=\\s*["'][^"']*${t}[^"']*["'][^>]*>`, "i");
}
const CONTAINER_PATTERNS = [
  /<(article|main|div|section)\b[^>]*\bid\s*=\s*["'][^"']*(?:js-article|article|post|content|main-content)[^"']*["'][^>]*>/i,
  /<(article|main|div|section)\b[^>]*\bclass\s*=\s*["'][^"']*(?:article-content|article-body|articleContent|post-content|entry-content|markdown-body|markdown|rich_media_content)[^"']*["'][^>]*>/i,
  /<article\b[^>]*>/i,
  /<(div|main|section)\b[^>]*\bclass\s*=\s*["'][^"']*content[^"']*["'][^>]*>/i,
];
function extractArticleHtml(html, container) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const patterns = container && container.trim() ? [containerPattern(container), ...CONTAINER_PATTERNS] : CONTAINER_PATTERNS;
  let open = null;
  for (const re of patterns) { open = cleaned.match(re); if (open && open.index != null) break; open = null; }
  if (!open || open.index == null) {
    const body = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    return body ? body[1] : cleaned;
  }
  const tag = open[1] ? open[1].toLowerCase() : "article";
  const start = open.index + open[0].length;
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
  re.lastIndex = start;
  let depth = 1, end = cleaned.length, m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[0][1] === "/") { depth -= 1; if (depth === 0) { end = m.index; break; } }
    else { depth += 1; }
  }
  return cleaned.slice(start, end);
}

// ── 忠实内联：stripHtml 文本剥离（normalize.ts；字数估算用，省略实体码点回填，足够判 ≥200）──
function stripText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|ul|ol|blockquote|section|article|table|thead|tbody|figure|figcaption|pre|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, ctype: res.headers.get("content-type") || "", body: buf.toString("utf8"), bytes: buf.length };
  } finally { clearTimeout(t); }
}

// ── 忠实内联 robots.ts: parseRobots/rulesForStatus/isAllowed（合规门）。
//    缘起 2026-06-28：Changelog 接入漏查 robots（probe 直 fetch 绕过、生产采集器却遵守 → ingest failed）。
//    生产按 origin 查 robots（feed=rss.ts:109 抛错 / 文章=article.ts:95 返 null），故对会抓的每个 origin 都查。
//    `*` 当字面量、网络不可达保守放行——与生产 robots.ts 完全一致。
function parseRobots(txt, ua) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim(); if (!line) continue;
    const idx = line.indexOf(":"); if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase(), value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase()); lastWasAgent = true;
    } else if (field === "disallow" && cur) { cur.disallow.push(value); lastWasAgent = false; }
    else { lastWasAgent = false; }
  }
  const uaLower = ua.toLowerCase();
  const mt = (g, star) => g.agents.some((a) => star ? a === "*" : a !== "*" && (uaLower.includes(a) || a.includes(uaLower)));
  const exact = groups.filter((g) => mt(g, false)), star = groups.filter((g) => mt(g, true));
  return { disallow: (exact.length ? exact : star).flatMap((g) => g.disallow).filter((d) => d !== "") };
}
function rulesForStatus(status, body, ua) {
  if (status >= 200 && status < 300) return parseRobots(body, ua);
  if (status >= 500) return { disallow: ["/"] };  // 5xx 保守视为全站禁（同生产）
  return { disallow: [] };                          // 4xx/404=无 robots → 放行全站
}
async function robotsCheck(url) {
  const u = new URL(url);
  try {
    const r = await get(new URL("/robots.txt", u.origin).toString());
    const rules = rulesForStatus(r.status, r.ok ? r.body : "", UA);
    return { status: r.status, allowed: !rules.disallow.some((d) => u.pathname.startsWith(d)), disallow: rules.disallow.slice(0, 8) };
  } catch { return { status: 0, allowed: true, note: "robots 不可达→保守放行(同生产)" }; }
}

// feed 首条 item 链接（RSS <link>…</link> 或 Atom <link href>）+ 全文承载判定。
function firstLink(feed) {
  // RSS: <item>…<link>URL</link>；Atom: <entry>…<link href="URL" .../>
  const item = feed.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/i);
  const scope = item ? item[0] : feed;
  let m = scope.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);   // Atom
  if (m) return m[1];
  m = scope.match(/<link\b[^>]*>([^<]+)<\/link>/i);                     // RSS
  return m ? m[1].trim() : null;
}
function feedCarriesFullText(feed) {
  const item = feed.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/i);
  const scope = item ? item[0] : feed;
  // RSS content:encoded / Atom <content …>…</content> 的正文长度（剥标签后）
  let m = scope.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)
       || scope.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
  const full = m ? stripText(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")).length : 0;
  m = scope.match(/<(?:summary|description)\b[^>]*>([\s\S]*?)<\/(?:summary|description)>/i);
  const summ = m ? stripText(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")).length : 0;
  return { full, summ };
}

(async () => {
  for (const c of CANDIDATES) {
    const out = { id: c.id, name: c.name, mode: c.mode };
    try {
      // ① 合规门：feed origin robots（生产 rss.ts:109 同款；不放行则生产 ingest 直接抛错——Changelog 即此）
      out.robots_feed = await robotsCheck(c.url);
      if (!out.robots_feed.allowed) { out.pass = false; out.blocked = "robots(feed)"; console.log(JSON.stringify(out)); continue; }
      const f = await get(c.url);
      out.feed = { status: f.status, bytes: f.bytes };
      if (f.ok) {
        const fc = feedCarriesFullText(f.body);
        out.feed.fullChars = fc.full; out.feed.summChars = fc.summ;
        const link = firstLink(f.body);
        out.feed.firstLink = link;
        if (c.mode === "full_text" && link) {
          // ② 合规门：文章页 origin robots（常与 feed 不同源；生产 article.ts:95 同款，不放行则该条返 null）
          out.robots_article = await robotsCheck(link);
          if (!out.robots_article.allowed) { out.article = { blocked: "robots" }; out.pass = false; console.log(JSON.stringify(out)); continue; }
          const a = await get(link);
          out.article = { status: a.status, bytes: a.bytes, ctype: a.ctype.split(";")[0] };
          if (a.ok && /html/i.test(a.ctype)) {
            // 无容器（全局兜底）+ 每个 guess 各抽一遍，报字数，挑最优
            const trials = [{ g: "(global)", chars: stripText(extractArticleHtml(a.body, null)).length }];
            for (const g of c.guesses) trials.push({ g, chars: stripText(extractArticleHtml(a.body, g)).length });
            trials.sort((x, y) => y.chars - x.chars);
            out.article.trials = trials;
            out.article.best = trials[0];
            out.article.pass = trials[0].chars >= MIN_ARTICLE_CHARS;
          }
        }
      }
    } catch (e) { out.error = String(e && e.message || e); }
    console.log(JSON.stringify(out));
  }
})();
JS

# base64 单行传输（mac base64 长输入会换行，tr 去掉；容器内解码成文件再跑）
B64=$(printf %s "$PROBE" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["echo '=== 候选源生产-IP 实测（UA=InsightAgentBot）==='; docker exec deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/probe.js && node /tmp/probe.js'"]}
EOF

echo "下发 SSM 探测（需本机 AWS 凭据 + 代理已开）..."
CMD=$(aws ssm send-command --region "$RGN" --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS" --query Command.CommandId --output text)
echo "CommandId=$CMD"
ST=Pending
for _ in $(seq 1 30); do
  ST=$(aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  if [ "$ST" = "Success" ] || [ "$ST" = "Failed" ]; then break; fi
  sleep 2
done
echo "Status=$ST"
echo "======================================================"
aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query StandardOutputContent --output text
ERR=$(aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query StandardErrorContent --output text)
[ -n "$ERR" ] && { echo "--- stderr ---"; echo "$ERR" | head -8; } || true
