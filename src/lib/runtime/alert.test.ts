import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAlertRequest,
  detectChannel,
  failureToNotification,
  notifyFailure,
  notifyReport,
  reportToNotification,
  sendAlert,
  shouldPushReport,
  type Notification,
  type ReportPush,
} from "./alert.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALERT_WEBHOOK;
  delete process.env.ALERT_CHANNEL;
  delete process.env.ALERT_FEISHU_SECRET;
  delete process.env.REPORT_PUSH;
  delete process.env.PUBLIC_BASE_URL;
});

const FAIL = { runId: "run_1", kind: "analyze", target: { topic_id: "t1" }, errorType: "Error", message: "boom" };
const N: Notification = { title: "🔴 标题", text: "正文 detail", priority: "high", tags: ["rotating_light"], link: "https://app/x" };

describe("failureToNotification", () => {
  it("高优 + 🔴 tag；errorType/message/目标/runId 进正文", () => {
    const n = failureToNotification(FAIL);
    expect(n.priority).toBe("high");
    expect(n.tags).toEqual(["rotating_light"]);
    expect(n.title).toContain("analyze");
    expect(n.text).toContain("boom");
    expect(n.text).toContain("t1"); // target 序列化进正文
    expect(n.text).toContain("run_1");
  });
  it("正文截断到 1000 字", () => {
    const n = failureToNotification({ ...FAIL, message: "x".repeat(2000) });
    expect(n.text.length).toBe(1000);
  });
  it("target 为 null 时不出'目标'行", () => {
    expect(failureToNotification({ ...FAIL, target: null }).text).not.toContain("目标：");
  });
});

const REPORT: ReportPush = {
  id: "rep_1",
  type: "brief",
  title: "AI 软件工程 · 今日 Brief",
  summary: "本期 3 条关键进展。",
  topicName: "AI 软件工程",
  citationCount: 7,
  insightCount: 3,
};

describe("shouldPushReport", () => {
  it("空 brief（无洞察）不推", () => {
    expect(shouldPushReport({ type: "brief", insightCount: 0 })).toBe(false);
    expect(shouldPushReport({ type: "brief", insightCount: undefined })).toBe(false);
  });
  it("非空 brief 推", () => {
    expect(shouldPushReport({ type: "brief", insightCount: 1 })).toBe(true);
  });
  it("deep_dive / initial_digest 即便 0 条也推（用户触发 / 冷启动首报）", () => {
    expect(shouldPushReport({ type: "deep_dive", insightCount: 0 })).toBe(true);
    expect(shouldPushReport({ type: "initial_digest", insightCount: 0 })).toBe(true);
  });
});

describe("reportToNotification", () => {
  it("默认优先级 + newspaper tag；类型标签/主题/摘要/引用数进正文", () => {
    const n = reportToNotification(REPORT, "https://app.example.com");
    expect(n.priority).toBe("default");
    expect(n.tags).toEqual(["newspaper"]);
    expect(n.title).toContain("今日 Brief");
    expect(n.title).toContain("AI 软件工程 · 今日 Brief");
    expect(n.text).toContain("主题：AI 软件工程");
    expect(n.text).toContain("本期 3 条关键进展");
    expect(n.text).toContain("引用：7 条");
  });
  it("deep-link = baseUrl + /reports/<id>，去尾斜杠", () => {
    expect(reportToNotification(REPORT, "https://app.example.com/").link).toBe("https://app.example.com/reports/rep_1");
    expect(reportToNotification(REPORT, "https://app.example.com").link).toBe("https://app.example.com/reports/rep_1");
  });
  it("baseUrl 缺失 → 无 link，推送仍可发", () => {
    expect(reportToNotification(REPORT, undefined).link).toBeUndefined();
    expect(reportToNotification(REPORT, "   ").link).toBeUndefined();
  });
  it("deep_dive / initial_digest 用各自类型标签", () => {
    expect(reportToNotification({ ...REPORT, type: "deep_dive" }).title).toContain("主题深挖");
    expect(reportToNotification({ ...REPORT, type: "initial_digest" }).title).toContain("初始综述");
  });
  it("正文截断到 1000 字", () => {
    expect(reportToNotification({ ...REPORT, summary: "x".repeat(2000) }).text.length).toBe(1000);
  });
});

describe("notifyReport", () => {
  const fetchOk = () => vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
  it("REPORT_PUSH 未置 1 → no-op，即便配了 webhook 也不发", () => {
    process.env.ALERT_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    notifyReport(REPORT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("REPORT_PUSH=1 + webhook → 发报告通知到该渠道，带 deep-link", async () => {
    process.env.REPORT_PUSH = "1";
    process.env.ALERT_WEBHOOK = "https://ntfy.sh/my-topic";
    process.env.PUBLIC_BASE_URL = "https://app.example.com";
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    notifyReport(REPORT);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const b = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(b.title).toContain("今日 Brief");
    expect(b.click).toBe("https://app.example.com/reports/rep_1");
  });
  it("REPORT_PUSH=1 但空 brief → 不发（shouldPushReport 拦下）", () => {
    process.env.REPORT_PUSH = "1";
    process.env.ALERT_WEBHOOK = "https://ntfy.sh/my-topic";
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    notifyReport({ ...REPORT, insightCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("REPORT_PUSH=1 但 webhook 未配 → no-op（notify 内层兜底）", () => {
    process.env.REPORT_PUSH = "1";
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    notifyReport(REPORT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("构造阶段抛出（ntfy override + 非法 URL）→ 永不逃逸，不连累报告生成", () => {
    process.env.REPORT_PUSH = "1";
    process.env.ALERT_WEBHOOK = "ntfy.sh/topic"; // 缺 scheme → new URL 抛
    process.env.ALERT_CHANNEL = "ntfy";
    vi.stubGlobal("fetch", fetchOk());
    expect(() => notifyReport(REPORT)).not.toThrow();
  });
});

describe("detectChannel", () => {
  it("飞书：host + /bot/v2/hook/ path", () => {
    expect(detectChannel("https://open.feishu.cn/open-apis/bot/v2/hook/abc")).toBe("feishu");
    expect(detectChannel("https://open.larksuite.com/open-apis/bot/v2/hook/abc")).toBe("feishu");
  });
  it("ntfy / slack / discord 按 host", () => {
    expect(detectChannel("https://ntfy.sh/my-topic")).toBe("ntfy");
    expect(detectChannel("https://hooks.slack.com/services/x")).toBe("slack");
    expect(detectChannel("https://discord.com/api/webhooks/1/y")).toBe("discord");
    expect(detectChannel("https://discordapp.com/api/webhooks/1/y")).toBe("discord");
  });
  it("未知 host / 非法 URL → generic", () => {
    expect(detectChannel("https://webhook.site/uuid")).toBe("generic");
    expect(detectChannel("not a url")).toBe("generic");
  });
  it("override（ALERT_CHANNEL）优先于 URL 识别", () => {
    expect(detectChannel("https://my-self-hosted.example/topic", "ntfy")).toBe("ntfy");
    expect(detectChannel("https://ntfy.sh/t", "GENERIC")).toBe("generic"); // 大小写无关
  });
  it("非法 override 被忽略，回落 URL 识别", () => {
    expect(detectChannel("https://ntfy.sh/t", "garbage")).toBe("ntfy");
  });
  it("lookalike 域名不误匹配（点边界）", () => {
    expect(detectChannel("https://myslack.com/hook")).toBe("generic"); // 不是 slack
    expect(detectChannel("https://notfeishu.cn/bot/v2/hook/x")).toBe("generic"); // 不是 feishu
    expect(detectChannel("https://evil-ntfy.sh.attacker.com/t")).toBe("generic");
    expect(detectChannel("https://hooks.slack.com/x")).toBe("slack"); // 真子域仍中
  });
});

describe("buildAlertRequest", () => {
  it("飞书：{msg_type:'text', content:{text}}，含标题/正文/链接", () => {
    const req = buildAlertRequest("https://open.feishu.cn/open-apis/bot/v2/hook/abc", N, "feishu");
    const b = JSON.parse(req.body);
    expect(b.msg_type).toBe("text");
    expect(b.content.text).toContain("🔴 标题");
    expect(b.content.text).toContain("正文 detail");
    expect(b.content.text).toContain("https://app/x");
    expect(b.timestamp).toBeUndefined(); // 无 secret → 不加签
  });
  it("飞书加签：含 timestamp + 精确 sign（钉死 HMAC key=`ts\\nsecret`、空 data、base64）", () => {
    const req = buildAlertRequest("https://open.feishu.cn/open-apis/bot/v2/hook/abc", N, "feishu", {
      feishuSecret: "s3cr3t",
      now: 1_700_000_000_000,
    });
    const b = JSON.parse(req.body);
    expect(b.timestamp).toBe("1700000000");
    // 精确值——独立用 node:crypto 复算飞书算法，钉死 key/data 顺序与编码（key/data 写反会变值，弱断言抓不到）
    const expected = createHmac("sha256", "1700000000\ns3cr3t").update("").digest("base64");
    expect(b.sign).toBe(expected);
  });
  it("ntfy：POST 到 origin、topic 取 path 末段、中文 title 进 JSON body、link→click", () => {
    const req = buildAlertRequest("https://ntfy.sh/my-topic", N, "ntfy");
    expect(req.url).toBe("https://ntfy.sh"); // origin，非含 topic 的原 URL
    const b = JSON.parse(req.body);
    expect(b.topic).toBe("my-topic");
    expect(b.title).toBe("🔴 标题");
    expect(b.message).toContain("正文");
    expect(b.priority).toBe(5); // high
    expect(b.click).toBe("https://app/x");
  });
  it("ntfy：空 topic（根 URL）抛清晰错误而非静默发坏请求", () => {
    expect(() => buildAlertRequest("https://ntfy.sh", N, "ntfy")).toThrow(/缺少 topic/);
    expect(() => buildAlertRequest("https://ntfy.sh/", N, "ntfy")).toThrow(/缺少 topic/);
  });
  it("ntfy：多段 path 取第一段；priority='default'→3", () => {
    const b = JSON.parse(buildAlertRequest("https://ntfy.sh/alpha/beta", { ...N, priority: "default" }, "ntfy").body);
    expect(b.topic).toBe("alpha"); // 第一段，非 beta
    expect(b.priority).toBe(3); // default 分支
  });
  it("无 link / 无 tags：flatten 不甩出 'undefined'、click/tags 字段被 JSON 丢弃", () => {
    const bare: Notification = { title: "T", text: "body", priority: "default" };
    const ntfy = JSON.parse(buildAlertRequest("https://ntfy.sh/t", bare, "ntfy").body);
    expect(ntfy.click).toBeUndefined();
    expect(ntfy.tags).toBeUndefined();
    const slack = JSON.parse(buildAlertRequest("https://hooks.slack.com/x", bare, "slack").body);
    expect(slack.text).toBe("T\nbody"); // 无尾随 link 行、无 "undefined"
    expect(slack.text).not.toContain("undefined");
  });
  it("discord 用 {content}、slack 用 {text}", () => {
    expect(JSON.parse(buildAlertRequest("https://discord.com/x", N, "discord").body).content).toContain("🔴 标题");
    expect(JSON.parse(buildAlertRequest("https://hooks.slack.com/x", N, "slack").body).text).toContain("🔴 标题");
  });
  it("generic：text + 结构化字段（webhook.site 调试用）", () => {
    const b = JSON.parse(buildAlertRequest("https://webhook.site/x", N, "generic").body);
    expect(b.text).toContain("🔴 标题");
    expect(b.title).toBe("🔴 标题");
    expect(b.priority).toBe("high");
    expect(b.link).toBe("https://app/x");
  });
});

describe("sendAlert（永不抛）", () => {
  it("按 req 描述发请求（url/method/headers/body 透传）", async () => {
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await sendAlert({ url: "https://x/y", method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [u, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(u).toBe("https://x/y");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe('{"a":1}');
  });
  it("fetch 抛出 → resolve 不抛（吞掉、不连累管线）", async () => {
    vi.stubGlobal("fetch", vi.fn((..._a: unknown[]) => Promise.reject(new Error("network"))));
    await expect(
      sendAlert({ url: "https://x", method: "POST", headers: {}, body: "{}" }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyFailure", () => {
  it("ALERT_WEBHOOK 未配置 → no-op，不触发 fetch", () => {
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    notifyFailure(FAIL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("飞书 URL → 发飞书 schema 到该 URL", async () => {
    process.env.ALERT_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    notifyFailure(FAIL);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [u, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(u).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/abc");
    expect(JSON.parse(opts.body as string).msg_type).toBe("text");
  });
  it("构造阶段抛出（ntfy override + 非法 URL）→ 永不逃逸，不连累调用方", () => {
    // jobs.ts 在 catch 里调本函数、紧接着重抛原始错误；本函数任何抛出都会顶替原始错误。
    process.env.ALERT_WEBHOOK = "ntfy.sh/topic"; // 缺 scheme → new URL 抛
    process.env.ALERT_CHANNEL = "ntfy"; // override 短路过 detectChannel 的 URL 校验，直达 buildNtfy
    vi.stubGlobal("fetch", vi.fn((..._a: unknown[]) => Promise.resolve(new Response(null, { status: 200 }))));
    expect(() => notifyFailure(FAIL)).not.toThrow();
  });
  it("不可序列化 target（循环引用）→ 永不逃逸", () => {
    process.env.ALERT_WEBHOOK = "https://webhook.site/x";
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => notifyFailure({ ...FAIL, target: circular })).not.toThrow();
  });
});
