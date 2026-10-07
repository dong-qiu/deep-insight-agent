import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { notify, type Notification } from "./alert.js";
import { notifyEmail, sendEmail, type Mail } from "./email.js";
import { RuntimeConfigError } from "./env.js";

// Exercise the real facades and sendEmail; isolate only transport, DB and logging.
const { warn, sendMail, createTransport, recipients } = vi.hoisted(() => ({
  warn: vi.fn(), sendMail: vi.fn(), createTransport: vi.fn(), recipients: vi.fn(),
}));
vi.mock("./logger.js", () => ({ runLogger: () => ({ warn }) }));
vi.mock("../db/index.js", () => ({ getDb: () => ({}) }));
vi.mock("../db/recipients.js", () => ({ listEnabledRecipientEmails: recipients }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const n: Notification = { title: "Synthetic notification", text: "Synthetic body", priority: "default" };
const mail: Mail = { from: "sender@example.invalid", to: "reader@example.invalid", subject: n.title, text: n.text, html: "<p>Synthetic</p>" };
const defaults: (string | undefined)[] = [undefined, "", " \t ", "0", "-0", "0.0", "0x0"];
const invalid = ["NaN", "Infinity", "-Infinity", "-1", "1.5", "9007199254740992", "synthetic-private-invalid-config"];

beforeEach(() => {
  vi.clearAllMocks();
  recipients.mockReturnValue([]);
  sendMail.mockResolvedValue({});
  createTransport.mockReturnValue({ sendMail });
  for (const name of ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "REPORT_EMAIL_TO", "SMTP_PORT", "ALERT_WEBHOOK", "ALERT_TIMEOUT_MS", "ALERT_CHANNEL"]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("SMTP_PORT real sendEmail preflight", () => {
  it.each(defaults)("preserves the safe default for %j", async (raw) => {
    vi.stubEnv("SMTP_PORT", raw);
    await sendEmail(mail);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true, connectionTimeout: 10_000 }));
    expect(sendMail).toHaveBeenCalledWith(mail);
  });

  it.each(["1", "65535", " 587 ", "4.65e2", "0x1d1"])("passes valid Number format %j to transport", async (raw) => {
    vi.stubEnv("SMTP_PORT", raw);
    await sendEmail(mail, 1234);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: Number(raw), secure: Number(raw) === 465, connectionTimeout: 1234, greetingTimeout: 1234, socketTimeout: 1234 }));
  });

  it.each([...invalid, "65536"])("rejects %j before any transport without echoing raw input", async (raw) => {
    vi.stubEnv("SMTP_PORT", raw);
    const error = await sendEmail(mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeConfigError);
    expect((error as Error).message).toContain("SMTP_PORT");
    expect((error as Error).message).not.toContain("synthetic-private-invalid-config");
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("reads each call without freezing TLS or port at import", async () => {
    vi.stubEnv("SMTP_PORT", "465"); await sendEmail(mail);
    vi.stubEnv("SMTP_PORT", "587"); await sendEmail(mail);
    expect(createTransport.mock.calls.map(([opts]) => ({ port: opts.port, secure: opts.secure }))).toEqual([{ port: 465, secure: true }, { port: 587, secure: false }]);
  });

  it.each(["SMTP_HOST", "REPORT_EMAIL_TO", "SMTP_FROM"])("disabled mail lacking %s remains no-op with invalid port", async (missing) => {
    vi.stubEnv("SMTP_HOST", "smtp.example.invalid"); vi.stubEnv("REPORT_EMAIL_TO", mail.to); vi.stubEnv("SMTP_FROM", mail.from);
    vi.stubEnv(missing, undefined); vi.stubEnv("SMTP_PORT", "Infinity");
    expect(() => notifyEmail(n)).not.toThrow();
    await Promise.resolve();
    expect(createTransport).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });

  it("enabled notification catches config rejection asynchronously and keeps best-effort", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.invalid"); vi.stubEnv("REPORT_EMAIL_TO", mail.to); vi.stubEnv("SMTP_FROM", mail.from);
    vi.stubEnv("SMTP_PORT", "synthetic-private-invalid-config");
    expect(notifyEmail(n)).toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledWith({ err: expect.any(RuntimeConfigError) }, "报告邮件发送失败（已忽略）");
    expect((warn.mock.calls[0][0].err as Error).message).not.toContain("synthetic-private-invalid-config");
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe("ALERT_TIMEOUT_MS real notify preflight", () => {
  function transport() {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); vi.stubEnv("ALERT_WEBHOOK", "https://notify.example.invalid/synthetic");
    return { fetchMock, timeout: vi.spyOn(AbortSignal, "timeout") };
  }

  it.each(defaults)("preserves the safe timer default for %j", (raw) => {
    const { fetchMock, timeout } = transport(); vi.stubEnv("ALERT_TIMEOUT_MS", raw);
    expect(notify(n)).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(5000); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["1", "2147483647", " 1234 ", "1e3", "0x10"])("passes safe timer %j to actual AbortSignal.timeout", (raw) => {
    const { fetchMock, timeout } = transport(); vi.stubEnv("ALERT_TIMEOUT_MS", raw);
    notify(n);
    expect(timeout).toHaveBeenCalledWith(Number(raw)); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([...invalid, "2147483648"])("contains invalid %j before timer or fetch", (raw) => {
    const { fetchMock, timeout } = transport(); vi.stubEnv("ALERT_TIMEOUT_MS", raw);
    expect(() => notify(n)).not.toThrow();
    expect(timeout).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ err: expect.any(RuntimeConfigError) }, "告警构造失败（已忽略）");
    expect((warn.mock.calls[0][0].err as Error).message).not.toContain("synthetic-private-invalid-config");
  });

  it("keeps absent webhook no-op even with invalid timer", () => {
    const { fetchMock, timeout } = transport(); vi.stubEnv("ALERT_WEBHOOK", undefined); vi.stubEnv("ALERT_TIMEOUT_MS", "Infinity");
    expect(notify(n)).toBeUndefined();
    expect(timeout).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });

  it("reads each notify call after module initialization", () => {
    const { timeout } = transport();
    vi.stubEnv("ALERT_TIMEOUT_MS", "1234"); notify(n);
    vi.stubEnv("ALERT_TIMEOUT_MS", "5678"); notify(n);
    expect(timeout.mock.calls).toEqual([[1234], [5678]]);
  });

  it("loads the real notification facades without reading invalid notification config", async () => {
    vi.resetModules();
    const previous = process.env;
    const reads: string[] = [];
    const importEnv: NodeJS.ProcessEnv = { ...previous, SMTP_PORT: "Infinity", ALERT_TIMEOUT_MS: "Infinity" };
    process.env = new Proxy(importEnv, {
      get(target, key: string) { if (key === "SMTP_PORT" || key === "ALERT_TIMEOUT_MS") reads.push(key); return target[key]; },
    });
    try {
      await import("./email.js"); await import("./alert.js");
      expect(reads).toEqual([]); expect(createTransport).not.toHaveBeenCalled();
    } finally { process.env = previous; }
  });
});
