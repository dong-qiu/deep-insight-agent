/** 邮件推送渠道（报告推送扇出之一 · product-definition「推送落地」邮件）：SMTP（nodemailer）。
 *  与 alert.ts 的 webhook 渠道层并列——报告推送（notifyReport）同时扇出到飞书 webhook + 邮件。
 *  - opt-in：需配 `SMTP_HOST` + `REPORT_EMAIL_TO`（缺一即 no-op，与 webhook 的 ALERT_WEBHOOK 同理）。
 *  - **非阻塞、永不抛**：与 notify/notifyFailure 同约束，邮件失败绝不连累已落库报告。
 *  - operator 配置、非用户输入，直连 SMTP（不走 SSRF 防护，那是给不可信源的）。 */
import nodemailer from "nodemailer";
import type { Notification } from "./alert.js";
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

/** 纯函数：中性 Notification → 邮件（subject=标题；正文=text + deep-link；text/html 双版本）。可测。 */
export function reportToEmail(n: Notification, from: string, to: string): Mail {
  const text = [n.text, n.link ? `\n查看完整报告：${n.link}` : ""].filter(Boolean).join("\n");
  const bodyHtml = esc(n.text).replace(/\n/g, "<br>");
  const linkHtml = n.link ? `<p><a href="${esc(n.link)}">查看完整报告 →</a></p>` : "";
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h3 style="margin:0 0 .5rem">${esc(n.title)}</h3><p style="margin:0 0 .5rem">${bodyHtml}</p>${linkHtml}</div>`;
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

/** 报告推送的邮件渠道入口：配了 SMTP_HOST + REPORT_EMAIL_TO 才发；fire-and-forget、永不抛。
 *  REPORT_EMAIL_TO 支持逗号分隔多收件人（nodemailer 直接收逗号串）。 */
export function notifyEmail(n: Notification): void {
  const host = process.env.SMTP_HOST;
  const to = process.env.REPORT_EMAIL_TO;
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
