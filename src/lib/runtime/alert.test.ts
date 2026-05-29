import { afterEach, describe, expect, it, vi } from "vitest";
import { failureAlertPayload, notifyFailure, sendAlert } from "./alert.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALERT_WEBHOOK;
});

describe("failureAlertPayload", () => {
  it("含 Slack 兼容 text + 结构化字段", () => {
    const p = failureAlertPayload({ runId: "run_1", kind: "analyze", target: { topic_id: "t1" }, errorType: "Error", message: "boom" });
    expect(p.text).toContain("Run 失败");
    expect(p.text).toContain("analyze");
    expect(p.text).toContain("boom");
    expect(p.runId).toBe("run_1");
    expect(p.error).toEqual({ type: "Error", message: "boom" });
  });
  it("text 截断到 500 字", () => {
    const p = failureAlertPayload({ runId: "r", kind: "analyze", target: null, errorType: "E", message: "x".repeat(999) });
    expect((p.text as string).length).toBe(500);
  });
});

describe("sendAlert（永不抛）", () => {
  it("POST 到 url、JSON body", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await sendAlert("https://hook.example/x", { text: "hi" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe("https://hook.example/x");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ text: "hi" });
  });
  it("fetch 抛出 → resolve 不抛（吞掉、不连累管线）", async () => {
    vi.stubGlobal("fetch", vi.fn((..._args: unknown[]) => Promise.reject(new Error("network"))));
    await expect(sendAlert("https://x", { text: "y" })).resolves.toBeUndefined();
  });
});

describe("notifyFailure", () => {
  it("ALERT_WEBHOOK 未配置 → no-op，不触发 fetch", () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    notifyFailure({ runId: "r", kind: "analyze", target: null, errorType: "E", message: "m" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("配置后 fire-and-forget 触发 fetch", async () => {
    process.env.ALERT_WEBHOOK = "https://hook.example/y";
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    notifyFailure({ runId: "r", kind: "analyze", target: null, errorType: "E", message: "m" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
