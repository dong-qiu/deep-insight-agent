/** Webhook channel protocol: request construction and response classification.
 * No transport, environment configuration, business notification policy or delivery state. */
import { createHmac } from "node:crypto";

/** 报告推送要点（渲染用最小结构）：`text`=一句话要点、`key`=是否重点关注（importance≥阈值）。
 *  由上层（report-gen.reportHighlights）按 importance 降序产出，渲染层只管分级不管排序。 */
export interface PushHighlight {
  text: string;
  key: boolean;
}

/** 中性通知消息——渠道 adapter 的统一输入。报告推送（B）产同结构复用渠道层。
 *  注意 `tags` 当前是 ntfy 的 emoji shortcode 词表（如 rotating_light）；slack/discord 忽略它。
 *  将来 report-push 若要带业务标签，需在渠道层做词表映射，勿直接塞业务 tag。 */
export interface Notification {
  title: string;
  text: string;
  priority: "high" | "default";
  tags?: string[];
  link?: string;
  /** 报告推送专用（可选）：结构化要点，供**邮件**富渲染分级列表（⭐重点/动态）。
   *  webhook 渠道忽略此字段、仍渲染 `text`（text 已含同款清单的纯文本版）。 */
  highlights?: PushHighlight[];
  /** 报告推送专用（可选）：要点清单下的元信息脚注（如「引用 12 条 · 还有 3 条见完整报告」）。
   *  已并入 `text`；邮件 HTML 另用它渲染脚注行。 */
  meta?: string;
}

export type ChannelId = "feishu" | "ntfy" | "slack" | "discord" | "generic";

/** 已序列化的 HTTP 请求描述——adapter 输出、sendAlert 消费（渠道差异不止 body，还有 url/method/header）。 */
export interface AlertRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** 渠道——供 sendAlert 做"HTTP 2xx 但应用层失败"识别（主要飞书）。缺省时 sendAlert 按 url 兜底识别。 */
  channel?: ChannelId;
}

const CHANNELS: readonly ChannelId[] = ["feishu", "ntfy", "slack", "discord", "generic"];

/** host 是否属于某域名——精确相等或真子域（`.domain` 后缀），避免 `myslack.com` 误中 `slack.com`。 */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** 纯函数：按 URL（host + path）识别渠道；`override`（ALERT_CHANNEL）优先。无法解析 → generic 兜底。 */
export function detectChannel(url: string, override?: string): ChannelId {
  const o = (override ?? "").trim().toLowerCase();
  if ((CHANNELS as readonly string[]).includes(o)) return o as ChannelId;
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return "generic";
  }
  if ((hostMatches(host, "feishu.cn") || hostMatches(host, "larksuite.com")) && path.includes("/bot/v2/hook/"))
    return "feishu";
  if (hostMatches(host, "ntfy.sh")) return "ntfy";
  if (hostMatches(host, "slack.com")) return "slack";
  if (hostMatches(host, "discord.com") || hostMatches(host, "discordapp.com")) return "discord";
  return "generic";
}

/** 一行可读文本（标题 + 正文 + 可选链接）——slack/discord/generic 复用。 */
function flatten(n: Notification): string {
  return `${n.title}\n${n.text}${n.link ? `\n${n.link}` : ""}`;
}

type Body = { url: string; body: string };

/** 飞书群机器人：`{msg_type:"text", content:{text}}`；配 `feishuSecret` 则加签（timestamp + sign）。 */
function buildFeishu(url: string, n: Notification, secret?: string, now?: number): Body {
  const body: Record<string, unknown> = { msg_type: "text", content: { text: flatten(n) } };
  if (secret) {
    // 飞书加签：sign = base64( HMAC-SHA256(key = "{timestamp}\n{secret}", data = 空) )
    const ts = Math.floor((now ?? Date.now()) / 1000).toString();
    body.timestamp = ts;
    body.sign = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  }
  return { url, body: JSON.stringify(body) };
}

/** ntfy：走 JSON publish 格式（POST 到 origin、topic 取自 path 第一段）——避开 HTTP header Title 仅 ASCII 的坑，中文标题正常。
 *  topic 为空（根 URL / 无路径段）直接抛——由 notifyFailure 兜底捕获并清晰报错，胜过静默发坏请求。 */
function buildNtfy(url: string, n: Notification): Body {
  const u = new URL(url);
  const topic = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (!topic) throw new Error(`ntfy ALERT_WEBHOOK 缺少 topic 路径段（应形如 https://ntfy.sh/<topic>）：${url}`);
  const body = JSON.stringify({
    topic,
    title: n.title,
    message: n.text,
    priority: n.priority === "high" ? 5 : 3,
    tags: n.tags,
    click: n.link,
  });
  return { url: u.origin, body };
}

/** 纯函数：把中性通知翻译成目标渠道的 HTTP 请求描述（method/headers 各渠道一致，集中设置）。 */
export function buildAlertRequest(
  url: string,
  n: Notification,
  channel: ChannelId,
  opts?: { feishuSecret?: string; now?: number },
): AlertRequest {
  let r: Body;
  switch (channel) {
    case "feishu":
      r = buildFeishu(url, n, opts?.feishuSecret, opts?.now);
      break;
    case "ntfy":
      r = buildNtfy(url, n);
      break;
    case "discord":
      r = { url, body: JSON.stringify({ content: flatten(n) }) };
      break;
    case "slack":
      r = { url, body: JSON.stringify({ text: flatten(n) }) };
      break;
    case "generic":
    default:
      r = { url, body: JSON.stringify({ text: flatten(n), title: n.title, priority: n.priority, tags: n.tags, link: n.link }) };
  }
  return { url: r.url, method: "POST", headers: { "content-type": "application/json" }, body: r.body, channel };
}

/** "HTTP 2xx 但应用层失败"的识别。主要针对飞书：群机器人即使关键词未命中 / 签名错 / 限流，也返
 *  HTTP 200，真实结果在 body.code（成功=0）。只看 HTTP 状态会把"已拒绝"当成"已发送"——告警静默
 *  失效、无人知（2026-06-13 实锤：关键词模式把陈旧告警吞了）。其余渠道 HTTP 状态本就准确（slack 200
 *  "ok" / discord 204 / ntfy 200），不强判，避免误报。返回错误描述或 null（成功/不适用）。 */
export function appLevelError(channel: ChannelId, body: string): string | null {
  if (channel !== "feishu") return null;
  if (!body) return null; // 防御：空 body 不误判
  try {
    const j = JSON.parse(body) as { code?: number; StatusCode?: number; msg?: string };
    const code = j.code ?? j.StatusCode ?? 0; // 飞书新/旧两种字段
    return code === 0 ? null : `feishu code=${code} msg=${j.msg ?? ""}`;
  } catch {
    return `feishu 响应非 JSON：${body.slice(0, 120)}`;
  }
}
