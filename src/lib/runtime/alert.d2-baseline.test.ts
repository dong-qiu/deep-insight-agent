import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appLevelError, buildAlertRequest, detectChannel, notify, sendAlert,
  type ChannelId, type Notification,
} from "./alert.js";

// Only transport/logging are mocked. All channel helpers and facade wiring are real.
const { warn, notifyEmail } = vi.hoisted(() => ({ warn: vi.fn(), notifyEmail: vi.fn() }));
vi.mock("./logger.js", () => ({ runLogger: () => ({ warn }) }));
vi.mock("./email.js", () => ({ notifyEmail }));

interface Baseline {
  baselineSha: string;
  detection: { url: string; override?: string; expected: ChannelId }[];
  requests: { url: string; notification: Notification; channel: string; opts?: { feishuSecret?: string; now?: number };
    expected: { url: string; method: string; headers: Record<string, string>; body: string; channel: string } }[];
  responses: { channel: string; body: string; expected: string | null }[];
}
// Frozen on the original implementation, before extraction. Never regenerate in tests.
const baseline = JSON.parse(readFileSync(new URL("../../../tests/fixtures/d2-alert-channel-baseline.json", import.meta.url), "utf8")) as Baseline;
const n: Notification = { title: "T", text: "body", priority: "default" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warn.mockClear();
  notifyEmail.mockClear();
});

describe("D2 original facade frozen contract", () => {
  it("binds expected values to the pre-extraction main", () => {
    expect(baseline.baselineSha).toBe("2bb91519a20cea09fdc387bcab0917728e28cdc4");
  });
  it.each(baseline.detection)("detect $url / $override", ({ url, override, expected }) => {
    expect(detectChannel(url, override)).toBe(expected);
  });
  it.each(baseline.requests)("request $channel / $url / $opts", (input) => {
    const notification = structuredClone(input.notification);
    Object.freeze(notification.tags);
    Object.freeze(notification.highlights);
    Object.freeze(notification);
    expect(buildAlertRequest(input.url, notification, input.channel as ChannelId, input.opts)).toEqual(input.expected);
    expect(notification).toEqual(input.notification);
  });
  it.each(baseline.responses)("response $channel / $body", ({ channel, body, expected }) => {
    expect(appLevelError(channel as ChannelId, body)).toBe(expected);
  });

  it("preserves the missing-topic error, and URL/JSON synchronous error classes", () => {
    for (const url of ["https://ntfy.sh", "https://ntfy.sh///"]) {
      expect(() => buildAlertRequest(url, n, "ntfy")).toThrow(
        `ntfy ALERT_WEBHOOK 缺少 topic 路径段（应形如 https://ntfy.sh/<topic>）：${url}`,
      );
    }
    expect(() => buildAlertRequest("invalid", n, "ntfy")).toThrow(TypeError);
    const circular: unknown[] = [];
    circular.push(circular);
    expect(() => buildAlertRequest("https://notify.invalid/x", { ...n, tags: circular as string[] }, "generic")).toThrow(TypeError);
  });

  it("propagates the same synchronous getter error instead of wrapping it", () => {
    const error = new Error("synthetic getter failure");
    const notification = { ...n, get title(): string { throw error; } };
    let caught: unknown;
    try { buildAlertRequest("https://notify.invalid/x", notification, "slack"); }
    catch (e) { caught = e; }
    expect(caught).toBe(error);
  });

  it("uses the current clock only for signed Feishu with omitted now", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_999);
    const signed = buildAlertRequest("https://notify.invalid/x", n, "feishu", { feishuSecret: "synthetic-signing-key" });
    expect(clock).toHaveBeenCalledOnce();
    expect(signed.body).toBe('{"msg_type":"text","content":{"text":"T\\nbody"},"timestamp":"1700000000","sign":"CfsjKkk/N10N4lTgUGC0Bc2ApREWup+8ePyAM6/V9I4="}');
    clock.mockClear();
    buildAlertRequest("https://notify.invalid/x", n, "feishu");
    buildAlertRequest("https://notify.invalid/x", n, "feishu", { feishuSecret: "" });
    buildAlertRequest("https://notify.invalid/x", n, "feishu", { feishuSecret: "synthetic-signing-key", now: 0 });
    buildAlertRequest("https://notify.invalid/x", n, "generic");
    expect(clock).not.toHaveBeenCalled();
  });
});

describe("D2 real notify → channel → sendAlert wiring", () => {
  it("reads webhook/channel/secret/timeout at each call and keeps fire-and-forget", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ALERT_WEBHOOK", "");
    expect(notify(n)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("ALERT_WEBHOOK", "https://notify.invalid/topic/extra");
    vi.stubEnv("ALERT_CHANNEL", "ntfy");
    vi.stubEnv("ALERT_TIMEOUT_MS", "1234");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    notify(n);
    expect(fetchMock).toHaveBeenCalledWith("https://notify.invalid", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"topic":"topic","title":"T","message":"body","priority":3}', signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenLastCalledWith(1234);
    vi.stubEnv("ALERT_CHANNEL", " feishu ");
    vi.stubEnv("ALERT_FEISHU_SECRET", "synthetic-signing-key");
    vi.stubEnv("ALERT_TIMEOUT_MS", "0");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    notify(n);
    expect(timeout).toHaveBeenLastCalledWith(5000);
    expect(fetchMock.mock.calls).toHaveLength(2);
    const call = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://notify.invalid/topic/extra");
    expect(call[1].body).toBe('{"msg_type":"text","content":{"text":"T\\nbody"},"timestamp":"1700000000","sign":"CfsjKkk/N10N4lTgUGC0Bc2ApREWup+8ePyAM6/V9I4="}');
    await vi.waitFor(() => expect(warn).not.toHaveBeenCalled());
    expect(notifyEmail).not.toHaveBeenCalled();
  });

  it("catches synchronous construction errors and dispatches nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ALERT_WEBHOOK", "invalid");
    vi.stubEnv("ALERT_CHANNEL", "ntfy");
    expect(() => notify(n)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ err: expect.any(TypeError) }, "告警构造失败（已忽略）");
  });

  it.each(["sync", "async"])("contains %s fetch failure", async (mode) => {
    const error = new Error("synthetic transport failure");
    vi.stubGlobal("fetch", vi.fn(() => {
      if (mode === "sync") throw error;
      return Promise.reject(error);
    }));
    await expect(sendAlert({ url: "https://notify.invalid/x", method: "POST", headers: {}, body: "{}" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ err: error }, "告警发送失败（已忽略）");
  });

  it.each([
    { status: 200, body: '{"code":19024,"msg":"synthetic private response"}', channel: "feishu" as const,
      reason: "webhook_application_rejected", message: "告警 webhook 应用层拒绝（HTTP 2xx 但未送达）" },
    { status: 503, body: '{"code":19024}', channel: "feishu" as const,
      reason: undefined, message: "告警 webhook 返回非 2xx" },
  ])("preserves $status warning classification without response text", async ({ status, body, channel, reason, message }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    await expect(sendAlert({ url: "https://notify.invalid/x", method: "POST", headers: {}, body: "{}", channel })).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([[reason ? { status, reason } : { status }, message]]);
  });

  it("falls back to URL detection when request channel is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"StatusCode":9499}', { status: 200 })));
    await sendAlert({ url: "https://open.feishu.cn/bot/v2/hook/synthetic", method: "POST", headers: {}, body: "{}" });
    expect(warn).toHaveBeenCalledWith({ status: 200, reason: "webhook_application_rejected" }, expect.any(String));
  });

  it("preserves empty-body fallback after async body-read failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: () => Promise.reject(new Error("synthetic read failure")) })));
    await expect(sendAlert({ url: "https://notify.invalid/x", method: "POST", headers: {}, body: "{}", channel: "feishu" })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("facade initialization does not read notification config or send (email/logger mocked)", async () => {
    vi.resetModules();
    const previousEnv = process.env;
    const reads: string[] = [];
    process.env = new Proxy(previousEnv, {
      get(target, key: string) {
        if (/^(ALERT_|REPORT_|BRIEF_|SMTP_)/.test(key)) reads.push(key);
        return target[key];
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await import("./alert.js");
      expect(reads).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(notifyEmail).not.toHaveBeenCalled();
    } finally { process.env = previousEnv; }
  });
});
