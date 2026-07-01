/** 邮件推送渠道（报告推送扇出之一 · product-definition「推送落地」邮件）：SMTP（nodemailer）。
 *  与 alert.ts 的 webhook 渠道层并列——报告推送（notifyReport）同时扇出到飞书 webhook + 邮件。
 *  - opt-in：需配 `SMTP_HOST` + `REPORT_EMAIL_TO`（缺一即 no-op，与 webhook 的 ALERT_WEBHOOK 同理）。
 *  - **非阻塞、永不抛**：与 notify/notifyFailure 同约束，邮件失败绝不连累已落库报告。
 *  - operator 配置、非用户输入，直连 SMTP（不走 SSRF 防护，那是给不可信源的）。 */
import nodemailer from "nodemailer";
import { getDb } from "../db/index.js";
import { listEnabledRecipientEmails } from "../db/recipients.js";
import type { Notification, PushHighlight } from "./alert.js";
import { runLogger } from "./logger.js";

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

// 邮件客户端多剥 <style>/外链，样式一律**内联**。用 system-ui 字体栈 + 克制配色，深浅色客户端都可读。
const WRAP = "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#1f2328;max-width:640px";
const CTA =
  "display:inline-block;margin:16px 0 0;padding:8px 16px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:6px;font-size:14px";

/** 一组要点 → HTML 列表段（标题 + <ul>）。key 组要点加粗、突出重点。 */
function highlightSection(heading: string, items: readonly PushHighlight[], bold: boolean): string {
  if (items.length === 0) return "";
  const lis = items
    .map((h) => {
      const t = esc(h.text);
      return `<li style="margin:6px 0">${bold ? `<strong>${t}</strong>` : t}</li>`;
    })
    .join("");
  return `<div style="font-weight:600;margin:14px 0 4px;color:#57606a;font-size:13px">${esc(heading)}</div><ul style="margin:0;padding-left:20px">${lis}</ul>`;
}

/** 富版式 HTML（有结构化要点时）：标题 + ⭐重点/动态 分级列表 + 元信息脚注 + CTA 按钮。 */
function richHtml(n: Notification): string {
  const hl = n.highlights ?? [];
  const keys = hl.filter((h) => h.key);
  const others = hl.filter((h) => !h.key);
  const keyHtml = highlightSection("⭐ 重点", keys, true);
  const otherHtml = highlightSection(keys.length ? "其他动态" : "动态", others, false);
  const metaHtml = n.meta ? `<p style="color:#656d76;font-size:13px;margin:16px 0 0">${esc(n.meta)}</p>` : "";
  const ctaHtml = n.link ? `<a href="${esc(n.link)}" style="${CTA}">查看完整报告 →</a>` : "";
  return `<div style="${WRAP}"><h2 style="margin:0 0 4px;font-size:18px">${esc(n.title)}</h2>${keyHtml}${otherHtml}${metaHtml}${ctaHtml}</div>`;
}

/** 纯版式 HTML（无结构化要点时的回退）：标题 + text（换行→<br>）+ 链接段。保持旧行为。 */
function plainHtml(n: Notification): string {
  const bodyHtml = esc(n.text).replace(/\n/g, "<br>");
  const linkHtml = n.link ? `<p><a href="${esc(n.link)}">查看完整报告 →</a></p>` : "";
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h3 style="margin:0 0 .5rem">${esc(n.title)}</h3><p style="margin:0 0 .5rem">${bodyHtml}</p>${linkHtml}</div>`;
}

/** 纯函数：中性 Notification → 邮件（subject=标题；text/html 双版本）。可测。
 *  有 `highlights` → 富版式（③ 视觉层次：⭐重点加粗分级 + CTA 按钮）；无则回退纯版式（旧行为）。
 *  text 版对两者一致：直接用 n.text（已含分级清单纯文本）+ deep-link 行。 */
export function reportToEmail(n: Notification, from: string, to: string): Mail {
  const text = [n.text, n.link ? `\n查看完整报告：${n.link}` : ""].filter(Boolean).join("\n");
  const html = n.highlights?.length ? richHtml(n) : plainHtml(n);
  return { from, to, subject: n.title, text, html };
}

/** SMTP 发送（nodemailer）。secure 按端口推断：465→TLS、其余→STARTTLS。可能抛——调用方 notifyEmail 兜。 */
export async function sendEmail(mail: Mail, timeoutMs = 10_000): Promise<void> {
  const port = Number(process.env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465=隐式 TLS；587/25=STARTTLS（secure:false 由 nodemailer 升级）
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs, // 防服务器在数据阶段挂住 → 连接长泄漏（fire-and-forget 不阻塞主流程，但别留挂起连接）
  });
  await transport.sendMail(mail);
}

/** 解析收件人（逗号串，给 nodemailer）：**DB 启用收件人优先，库空/读取失败才回落 env REPORT_EMAIL_TO**。
 *  收件名单从"改服务器 env"迁到"设置页管理"——库里有启用收件人即以库为准；兜底保证迁移期/库异常时不断流。 */
export function resolveRecipientEmails(): string {
  try {
    const emails = listEnabledRecipientEmails(getDb());
    if (emails.length) return emails.join(",");
  } catch (e) {
    // 库不可用（迁移未跑 / 连接异常）→ 回落 env，绝不让收件人解析抛断推送
    runLogger({ stage: "alert" }).warn(
      { err: e instanceof Error ? e.message : String(e) },
      "读取邮件收件人表失败，回落 REPORT_EMAIL_TO",
    );
  }
  return (process.env.REPORT_EMAIL_TO ?? "").trim();
}

/** 报告推送的邮件渠道入口：配了 SMTP_HOST + 收件人 + 发件人才发；fire-and-forget、永不抛。
 *  收件人 = DB 启用名单（设置页管理）优先，库空回落 env REPORT_EMAIL_TO（见 resolveRecipientEmails）。 */
export function notifyEmail(n: Notification): void {
  const host = process.env.SMTP_HOST;
  const to = resolveRecipientEmails();
  const from = (process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "").trim();
  if (!host || !to || !from) return; // 未配置（缺 host / 收件人 / 发件人）→ no-op，绝不发空 from
  try {
    const mail = reportToEmail(n, from, to);
    void sendEmail(mail).catch((e) =>
      runLogger({ stage: "alert" }).warn({ err: e instanceof Error ? e.message : String(e) }, "报告邮件发送失败（已忽略）"),
    );
  } catch (e) {
    runLogger({ stage: "alert" }).warn({ err: e instanceof Error ? e.message : String(e) }, "报告邮件构造失败（已忽略）");
  }
}
