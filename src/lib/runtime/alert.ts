/** 失败告警 + 多渠道 adapter（运维 · DCP-3 ②）：Run 失败时按 ALERT_WEBHOOK 自动识别渠道发送。
 *  - `ALERT_WEBHOOK` 未配置 → no-op（失败已落 Run + error 日志，告警是 opt-in 增强）。
 *  - 渠道按 URL 自动识别（feishu / ntfy / slack / discord / generic）；`ALERT_CHANNEL` 可显式覆盖
 *    （自建 ntfy 用自定义域名时的逃生舱）。
 *  - **默认主推飞书**：国内直通、安卓/iOS/鸿蒙 NEXT 全原生 App；ntfy 自托管后更优；slack/discord 国内需 VPN。
 *  - 消息先归一到中性 `Notification`，渠道层与来源解耦——将来「报告推送」产同结构即可复用本层。
 *  - operator 配置、非用户输入，故直连 fetch（不走 SSRF safe-fetch，那是给不可信源 URL 的）。
 *  - **非阻塞、永不抛/拒**：notifyFailure 全程 try/catch 兜底（构造阶段的 new URL / JSON.stringify 也可能抛），
 *    告警自身失败绝不连累管线——尤其不能顶替 runJob catch 里待重抛的原始错误。 */
import { createHmac } from "node:crypto";
import { runLogger } from "./logger.js";

export interface FailureAlert {
  runId: string;
  kind: string;
  target: unknown;
  errorType: string;
  message: string;
}

/** 中性通知消息——渠道 adapter 的统一输入。报告推送（B）将来产同结构复用渠道层。
 *  注意 `tags` 当前是 ntfy 的 emoji shortcode 词表（如 rotating_light）；slack/discord 忽略它。
 *  将来 report-push 若要带业务标签，需在渠道层做词表映射，勿直接塞业务 tag。 */
export interface Notification {
  title: string;
  text: string;
  priority: "high" | "default";
  tags?: string[];
  link?: string;
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

/** 纯函数：Run 失败 → 中性通知（高优 + 🔴 tag；runId/目标内联进正文便于回查）。 */
export function failureToNotification(a: FailureAlert): Notification {
  const targetStr =
    a.target == null ? "" : typeof a.target === "string" ? a.target : JSON.stringify(a.target);
  const text = [`${a.errorType}：${a.message}`, targetStr ? `目标：${targetStr}` : "", `runId：${a.runId}`]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
  return { title: `🔴 Run 失败：${a.kind}`, text, priority: "high", tags: ["rotating_light"] };
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

/** 发送一条告警 —— 超时（代码库惯用 AbortSignal.timeout）+ 全捕获，**永不抛/拒**（resolve 即可，失败只 warn 日志）。
 *  读响应体并做应用层校验（appLevelError）：HTTP 2xx 不等于送达——尤其飞书 200+code≠0。 */
export async function sendAlert(req: AlertRequest, timeoutMs = 5000): Promise<void> {
  const log = runLogger({ stage: "alert" });
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      log.warn({ status: res.status, body: text.slice(0, 200) }, "告警 webhook 返回非 2xx");
      return;
    }
    const appErr = appLevelError(req.channel ?? detectChannel(req.url), text);
    if (appErr) log.warn({ detail: appErr }, "告警 webhook 应用层拒绝（HTTP 2xx 但未送达）");
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "告警发送失败（已忽略）");
  }
}

/** Run 失败时调用：ALERT_WEBHOOK 配置则按渠道 fire-and-forget 发送。
 *  全程 try/catch——构造阶段（detectChannel/buildAlertRequest 的 new URL、failureToNotification 的 JSON.stringify）
 *  也可能抛，绝不能逃逸到 runJob catch 顶替待重抛的原始错误。 */
export function notifyFailure(a: FailureAlert): void {
  // failureToNotification 的 JSON.stringify(target) 可能抛（循环引用）——必须在 try 内构造，
  // 绝不逃逸到 runJob catch 顶替待重抛的原始错误。
  try {
    notify(failureToNotification(a));
  } catch (e) {
    runLogger({ stage: "alert" }).warn({ err: e instanceof Error ? e.message : String(e) }, "失败告警构造失败（已忽略）");
  }
}

/** 发一条中性通知：ALERT_WEBHOOK 配置则按渠道 fire-and-forget 发送，否则 no-op。
 *  全程 try/catch——构造阶段（detectChannel/buildAlertRequest 的 new URL 等）也可能抛，
 *  绝不能逃逸到调用方（如 runJob catch 顶替待重抛的原始错误，或 watchdog tick）。
 *  通用入口：Run 失败（notifyFailure）、数据陈旧（staleness）、将来报告推送（B）共用渠道层。 */
export function notify(n: Notification): void {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return; // 未配置 → no-op
  try {
    const timeoutMs = Number(process.env.ALERT_TIMEOUT_MS) || 5000;
    const channel = detectChannel(url, process.env.ALERT_CHANNEL);
    const req = buildAlertRequest(url, n, channel, { feishuSecret: process.env.ALERT_FEISHU_SECRET });
    void sendAlert(req, timeoutMs);
  } catch (e) {
    runLogger({ stage: "alert" }).warn({ err: e instanceof Error ? e.message : String(e) }, "告警构造失败（已忽略）");
  }
}
