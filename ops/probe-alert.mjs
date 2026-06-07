/** 失败告警手测探针（DCP-3 ②）：读 ALERT_WEBHOOK，按渠道构造一条 fake 告警发一次。
 *
 *  渠道识别 + payload 构造逻辑是 src/lib/runtime/alert.ts 的**内联镜像**（ops 为 .mjs、无 TS build，
 *  不能直接 import alert.ts）。改 alert.ts 的 adapter 时，这里同步跟改。单测覆盖以 alert.test.ts 为准。
 *
 *  用法：
 *    本地：    ALERT_WEBHOOK=<url> node ops/probe-alert.mjs
 *    容器内：  docker compose exec -T -e ALERT_WEBHOOK=<url> app node /app/ops/probe-alert.mjs
 *    自建域名 ntfy：再加 ALERT_CHANNEL=ntfy；飞书加签：再加 ALERT_FEISHU_SECRET=<secret>
 *
 *  退出码 0 = sendAlert resolve（按设计永不抛）；1 = ALERT_WEBHOOK 未设置 */
import { createHmac } from "node:crypto";

const url = process.env.ALERT_WEBHOOK;
if (!url) {
  console.error("❌ ALERT_WEBHOOK 未设置——本探针专测告警链路，需要一个 webhook URL（飞书 / ntfy / webhook.site 等）。");
  process.exit(1);
}

const CHANNELS = ["feishu", "ntfy", "slack", "discord", "generic"];

const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function detectChannel(u, override) {
  const o = (override ?? "").trim().toLowerCase();
  if (CHANNELS.includes(o)) return o;
  let host = "";
  let path = "";
  try {
    const x = new URL(u);
    host = x.hostname.toLowerCase();
    path = x.pathname;
  } catch {
    return "generic";
  }
  if ((hostMatches(host, "feishu.cn") || hostMatches(host, "larksuite.com")) && path.includes("/bot/v2/hook/")) return "feishu";
  if (hostMatches(host, "ntfy.sh")) return "ntfy";
  if (hostMatches(host, "slack.com")) return "slack";
  if (hostMatches(host, "discord.com") || hostMatches(host, "discordapp.com")) return "discord";
  return "generic";
}

const n = {
  title: "🔴 Run 失败：smoke",
  text: `TestError：本条来自 ops/probe-alert.mjs 的手测烟雾 / 非真实故障\nrunId：probe-${Math.random().toString(36).slice(2, 10)}`,
  priority: "high",
  tags: ["rotating_light"],
  link: undefined, // 失败告警无 link；保留字段位以与 alert.ts 的 flatten/generic/ntfy click 对齐
};
const flatten = (m) => `${m.title}\n${m.text}${m.link ? `\n${m.link}` : ""}`;
const flat = flatten(n);
const JSON_CT = { "content-type": "application/json" };

function buildRequest(u, channel) {
  if (channel === "feishu") {
    const body = { msg_type: "text", content: { text: flat } };
    const secret = process.env.ALERT_FEISHU_SECRET;
    if (secret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      body.timestamp = ts;
      body.sign = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
    }
    return { url: u, method: "POST", headers: JSON_CT, body: JSON.stringify(body) };
  }
  if (channel === "ntfy") {
    const x = new URL(u);
    const topic = x.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!topic) throw new Error(`ntfy ALERT_WEBHOOK 缺少 topic 路径段（应形如 https://ntfy.sh/<topic>）：${u}`);
    const body = { topic, title: n.title, message: n.text, priority: n.priority === "high" ? 5 : 3, tags: n.tags, click: n.link };
    return { url: x.origin, method: "POST", headers: JSON_CT, body: JSON.stringify(body) };
  }
  if (channel === "discord")
    return { url: u, method: "POST", headers: JSON_CT, body: JSON.stringify({ content: flat }) };
  if (channel === "slack")
    return { url: u, method: "POST", headers: JSON_CT, body: JSON.stringify({ text: flat }) };
  return {
    url: u,
    method: "POST",
    headers: JSON_CT,
    body: JSON.stringify({ text: flat, title: n.title, priority: n.priority, tags: n.tags, link: n.link }),
  };
}

const channel = detectChannel(url, process.env.ALERT_CHANNEL);
let req;
try {
  req = buildRequest(url, channel);
} catch (e) {
  console.error(`❌ 配置错误（渠道=${channel}）：${e instanceof Error ? e.message : String(e)}`);
  console.error("   多半是 ALERT_WEBHOOK 写错（缺 scheme / ntfy 缺 topic 路径段）。修正后重试。");
  process.exit(1);
}

console.log(`📡 渠道识别 = ${channel}`);
console.log(`   POST → ${req.url}`);
console.log(`   body = ${req.body}`);

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 5000);
try {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal });
  console.log(`✅ HTTP ${res.status} ${res.statusText}`);
  if (!res.ok)
    console.warn("   ⚠️ 非 2xx——webhook.site 仍会展示请求体；飞书/ntfy 等严格端 4xx 多半是 URL 错或 payload 不符（或飞书开了签名校验但未设 ALERT_FEISHU_SECRET）。");
} catch (e) {
  console.error(`❌ 发送失败：${e instanceof Error ? e.message : String(e)}`);
  console.error("   常见原因：① 网络不通；② URL 错；③ 渠道服务挂；④ 容器内 fetch 被防火墙拦。");
} finally {
  clearTimeout(timer);
}

console.log(`\n👀 去 ${channel === "generic" ? "webhook.site inbox" : "你的手机 App"} 确认这条是否到达。`);
