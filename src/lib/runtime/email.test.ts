import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "./alert.js";
// nodemailer mock——notifyEmail 经 sendEmail 调它；无 SMTP、CI 可跑。
const sendMail = vi.fn().mockResolvedValue({});
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));
// DB 层 mock——单测保持隔离不碰真库；默认收件人表为空 → notifyEmail 回落 env REPORT_EMAIL_TO。
const enabledRecipients = vi.fn<() => string[]>(() => []);
vi.mock("../db/index.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../db/recipients.js", () => ({ listEnabledRecipientEmails: () => enabledRecipients() }));
import nodemailer from "nodemailer";
import { notifyEmail, reportToEmail, resolveRecipientEmails } from "./email.js";

const n: Notification = { title: "📰 今日 Brief：AI 软件工程", text: "主题：AI 软件工程\n要点摘要", priority: "default", link: "https://x.example/reports/rep_1" };

describe("reportToEmail（纯函数）", () => {
  it("subject=标题；text 含正文 + deep-link；html 转义", () => {
    const m = reportToEmail(n, "bot@x.com", "a@x.com,b@x.com");
    expect(m.subject).toBe(n.title);
    expect(m.from).toBe("bot@x.com");
    expect(m.to).toBe("a@x.com,b@x.com");
    expect(m.text).toContain("要点摘要");
    expect(m.text).toContain("https://x.example/reports/rep_1"); // deep-link 进正文
    expect(m.html).toContain("查看完整报告");
  });
  it("无 link → 不渲染链接段；text 不含 undefined", () => {
    const m = reportToEmail({ ...n, link: undefined }, "f@x.com", "t@x.com");
    expect(m.text).not.toContain("查看完整报告");
    expect(m.html).not.toContain("<a href");
  });
  it("HTML 转义防注入（标题/正文含 < > &）", () => {
    const m = reportToEmail({ ...n, title: "a<b>&c", text: "x<script>y" }, "f", "t");
    expect(m.html).toContain("a&lt;b&gt;&amp;c");
    expect(m.html).not.toContain("<script>");
  });
});

describe("reportToEmail（富版式 · ③ 有结构化要点）", () => {
  const rich: Notification = {
    title: "📰 今日 Brief · 5 条｜要点甲",
    text: "主题：X\n\n⭐ 重点\n• 要点甲\n\n其他动态\n• 要点乙\n\n引用 7 条 · 还有 2 条见完整报告",
    priority: "default",
    link: "https://x.example/reports/rep_1",
    highlights: [
      { text: "要点甲", key: true },
      { text: "要点乙", key: false },
    ],
    meta: "引用 7 条 · 还有 2 条见完整报告",
  };
  it("有 highlights → 富版式：⭐重点段 + 动态段 + CTA 按钮 + 脚注", () => {
    const m = reportToEmail(rich, "f@x.com", "t@x.com");
    expect(m.html).toContain("⭐ 重点");
    expect(m.html).toContain("其他动态");
    expect(m.html).toContain("查看完整报告 →");
    expect(m.html).toContain("引用 7 条 · 还有 2 条见完整报告"); // meta 脚注
    expect(m.html).toContain("<ul");
  });
  it("重点要点加粗（<strong>），动态不加粗", () => {
    const m = reportToEmail(rich, "f", "t");
    expect(m.html).toContain("<strong>要点甲</strong>");
    expect(m.html).toContain("<li style=\"margin:6px 0\">要点乙</li>"); // 非重点无 strong
  });
  it("CTA 按钮指向 deep-link；无 link 则不渲染按钮", () => {
    expect(reportToEmail(rich, "f", "t").html).toContain('href="https://x.example/reports/rep_1"');
    expect(reportToEmail({ ...rich, link: undefined }, "f", "t").html).not.toContain("<a href");
  });
  it("富版式仍转义（要点含 < > &）", () => {
    const m = reportToEmail({ ...rich, highlights: [{ text: "a<b>&c", key: true }] }, "f", "t");
    expect(m.html).toContain("a&lt;b&gt;&amp;c");
    expect(m.html).not.toContain("<b>&c");
  });
  it("text 版对富/纯一致（直接用 n.text + deep-link）", () => {
    const m = reportToEmail(rich, "f", "t");
    expect(m.text).toContain("⭐ 重点");
    expect(m.text).toContain("查看完整报告：https://x.example/reports/rep_1");
  });
});

describe("notifyEmail（门控 + 扇出）", () => {
  const ENV = { ...process.env };
  beforeEach(() => { sendMail.mockClear(); enabledRecipients.mockReturnValue([]); });
  afterEach(() => { process.env = { ...ENV }; });

  it("未配 SMTP_HOST → no-op、不发", () => {
    delete process.env.SMTP_HOST; process.env.REPORT_EMAIL_TO = "a@x.com";
    notifyEmail(n);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("未配 REPORT_EMAIL_TO → no-op、不发", () => {
    process.env.SMTP_HOST = "smtp.x.com"; delete process.env.REPORT_EMAIL_TO;
    notifyEmail(n);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("配齐 SMTP_HOST + REPORT_EMAIL_TO → 发送（收件人/主题正确）", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.REPORT_EMAIL_TO = "a@x.com,b@x.com";
    process.env.SMTP_FROM = "bot@x.com";
    notifyEmail(n);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "a@x.com,b@x.com", subject: n.title, from: "bot@x.com" });
  });
  it("SMTP_FROM 缺省回退 SMTP_USER", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.REPORT_EMAIL_TO = "a@x.com";
    delete process.env.SMTP_FROM; process.env.SMTP_USER = "user@x.com";
    notifyEmail(n);
    expect(sendMail.mock.calls[0][0].from).toBe("user@x.com");
  });
  it("from 为空（无 SMTP_FROM/USER）→ no-op、不发", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.REPORT_EMAIL_TO = "a@x.com";
    delete process.env.SMTP_FROM; delete process.env.SMTP_USER;
    notifyEmail(n);
    expect(sendMail).not.toHaveBeenCalled();
  });

  // 收件人来源迁移：DB 启用名单优先，库空回落 env
  it("DB 有启用收件人 → 以库为准（覆盖 env REPORT_EMAIL_TO）", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.SMTP_FROM = "bot@x.com";
    process.env.REPORT_EMAIL_TO = "envonly@x.com"; // 应被库覆盖
    enabledRecipients.mockReturnValue(["a@db.com", "b@db.com"]);
    notifyEmail(n);
    expect(sendMail.mock.calls[0][0].to).toBe("a@db.com,b@db.com");
  });
  it("DB 名单空 → 回落 env REPORT_EMAIL_TO", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.SMTP_FROM = "bot@x.com";
    process.env.REPORT_EMAIL_TO = "fallback@x.com";
    enabledRecipients.mockReturnValue([]);
    notifyEmail(n);
    expect(sendMail.mock.calls[0][0].to).toBe("fallback@x.com");
  });
  it("DB 与 env 皆空 → no-op、不发", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.SMTP_FROM = "bot@x.com";
    delete process.env.REPORT_EMAIL_TO;
    enabledRecipients.mockReturnValue([]);
    notifyEmail(n);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("读库抛错 → 回落 env、仍发（resolveRecipientEmails 不抛）", () => {
    process.env.REPORT_EMAIL_TO = "fallback@x.com";
    enabledRecipients.mockImplementationOnce(() => { throw new Error("db locked"); });
    expect(resolveRecipientEmails()).toBe("fallback@x.com");
  });

  // 核心不变量：推送失败绝不连累已落库报告 → notifyEmail 永不抛
  it("sendMail reject（SMTP 发送失败）→ notifyEmail 不抛", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.REPORT_EMAIL_TO = "a@x.com"; process.env.SMTP_FROM = "f@x.com";
    sendMail.mockRejectedValueOnce(new Error("SMTP 535 auth failed"));
    expect(() => notifyEmail(n)).not.toThrow();
  });
  it("createTransport 同步抛 → notifyEmail 不抛（async 包成 rejected promise 被接住）", () => {
    process.env.SMTP_HOST = "smtp.x.com"; process.env.REPORT_EMAIL_TO = "a@x.com"; process.env.SMTP_FROM = "f@x.com";
    vi.mocked(nodemailer.createTransport).mockImplementationOnce(() => { throw new Error("bad config"); });
    expect(() => notifyEmail(n)).not.toThrow();
  });
});
