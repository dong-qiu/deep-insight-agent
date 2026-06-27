#!/usr/bin/env bash
# 播客转写源「生产 IP 可达性 + robots 合规 + 转写抽取」实测（接入/改适配器前门禁）。
# robots 门为 2026-06-28 补：Changelog 接入漏查 robots（probe 绕过、生产遵守 → ingest failed）的修复。
# 配套 2026-06-26 改动：① Changelog 接入（feed 带 text/html 转写 URL，新 extractCiteTranscript 抽 <cite>/<p>）；
# ② Practical AI 放开 rel="captions" vtt/srt 兜底（修元数据退化）。本机 curl 200 ≠ 生产可达，故用 app 真实
# UA（InsightAgentBot）+ Node fetch 在生产主机实测；抽取逻辑**忠实内联** normalize.ts，只回传字数 + 样本。
# 走 SSM 在容器 deep-insight-app-1 跑 node。前置：本机 AWS 凭据 + 代理。用法：./probe-podcast-transcripts.sh
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad

read -r -d '' PROBE <<'JS' || true
"use strict";
const UA = "InsightAgentBot";
const TIMEOUT = 12000;

// ── 忠实内联 normalize.ts: stripHtml（字数估算用，省实体码点回填）──
function stripHtml(h) {
  return h.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|ul|ol|blockquote|section|article|table|thead|tbody|figure|figcaption|pre|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'");
}
// ── 忠实内联 normalize.ts: extractCiteTranscript（Changelog）──
const CITE_OR_P = /<(cite|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const LEADING_TS = /^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/;
function extractCiteTranscript(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const scope = body ? body[1] : html;
  const lines = []; let speaker = "";
  for (const m of scope.matchAll(CITE_OR_P)) {
    const val = stripHtml(m[2]).replace(/\s+/g, " ").trim();
    if (m[1].toLowerCase() === "cite") speaker = val.replace(/:\s*$/, "");
    else if (val) { const t = val.replace(LEADING_TS, "").trim(); if (t) lines.push(speaker ? speaker + ": " + t : t); }
  }
  return lines.join("\n").trim();
}
// ── 忠实内联 normalize.ts: stripTranscript（vtt/srt）──
function stripTranscript(raw) {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/); const out = []; let skip = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { skip = false; continue; } if (skip) continue;
    if (/^WEBVTT/i.test(l)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(l)) { skip = true; continue; }
    if (/-->/.test(l)) continue;
    if (/^\d+$/.test(l)) { let j = i + 1; while (j < lines.length && !lines[j].trim()) j++; if (/-->/.test((lines[j] || "").trim())) continue; }
    out.push(l);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
// ── 忠实内联 rss.ts: pickTranscriptUrl（非 captions 全文）。扫前 N 条 item，返首个带可用转写的。
function pickTranscript(feed) {
  const items = [...feed.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 20);
  for (const it of items) {
    const tags = [...it[0].matchAll(/<podcast:transcript\b([^>]*?)\/?>/gi)].map((m) => {
      const a = m[1];
      return { url: (a.match(/url="([^"]+)"/i) || [])[1], type: (a.match(/type="([^"]+)"/i) || [])[1] || "", rel: (a.match(/rel="([^"]+)"/i) || [])[1] || "" };
    }).filter((t) => t.url && t.rel !== "captions");
    if (tags.length) { tags.sort((a, b) => (/plain/.test(a.type) ? 0 : 1) - (/plain/.test(b.type) ? 0 : 1)); return tags[0]; }
  }
  return null;
}

async function get(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: c.signal });
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, ctype: (r.headers.get("content-type") || "").split(";")[0], body: b.toString("utf8"), bytes: b.length };
  } finally { clearTimeout(t); }
}

// ── 忠实内联 robots.ts: parseRobots/rulesForStatus/isAllowed（合规门）。
//    缘起 2026-06-28：Changelog 接入漏查 robots（probe 直 fetch 绕过、生产采集器却遵守 → ingest failed）。
//    生产在 3 处各按 origin 查 robots（feed=rss.ts:109 抛错 / 转写=rss.ts:125 / 文章=article.ts:95），
//    故 probe 对每个会抓的 origin 都查。`*` 当字面量、网络不可达保守放行——与生产 robots.ts 完全一致。
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

const TARGETS = [
  { id: "src_changelog", feed: "https://changelog.com/podcast/feed", extractor: "cite" },
  { id: "src_practical_ai", feed: "https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm", extractor: "vtt" },
];

(async () => {
  for (const tgt of TARGETS) {
    const out = { id: tgt.id };
    try {
      // ① 合规门：feed origin robots（生产 rss.ts:109 同款；不放行则生产 ingest 直接抛错）
      out.robots_feed = await robotsCheck(tgt.feed);
      if (!out.robots_feed.allowed) { out.pass = false; out.blocked = "robots(feed)"; console.log(JSON.stringify(out)); continue; }
      const f = await get(tgt.feed);
      out.feed = { status: f.status, bytes: f.bytes };
      if (f.ok) {
        const tr = pickTranscript(f.body);
        out.transcript_url = tr ? tr.url : null;
        out.transcript_kind = tr ? (tr.rel === "captions" ? "captions:" + tr.type : tr.type) : null;
        if (tr && tr.url) {
          // ② 合规门：转写页 origin robots（常与 feed 不同源；生产 rss.ts:125 同款，不放行则该条返 null）
          out.robots_transcript = await robotsCheck(tr.url);
          if (!out.robots_transcript.allowed) { out.pass = false; out.blocked = "robots(transcript)"; console.log(JSON.stringify(out)); continue; }
          const p = await get(tr.url);
          const txt = tgt.extractor === "cite" ? extractCiteTranscript(p.body) : stripTranscript(p.body);
          out.page = { status: p.status, ctype: p.ctype, bytes: p.bytes, chars: txt.length, sample: txt.slice(0, 140).replace(/\s+/g, " ") };
          out.pass = p.ok && txt.length >= 500; // 转写应有可观字数
        }
      }
    } catch (e) { out.error = String((e && e.message) || e); }
    console.log(JSON.stringify(out));
  }
})();
JS

B64=$(printf %s "$PROBE" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["echo '=== 播客转写生产-IP 实测（UA=InsightAgentBot）==='; docker exec deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/ptp.js && node /tmp/ptp.js'"]}
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
