import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, isPrivateOrReserved, readTextCapped, safeFetch } from "./safe-fetch.js";

const enc = new TextEncoder();
/** 用多块 ReadableStream 造 Response，逐块触发 readTextCapped 的 maxBytes 判定。 */
function streamResponse(parts: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream);
}

describe("isPrivateOrReserved", () => {
  it("私有 / 保留 IPv4 → true", () => {
    for (const ip of ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "192.0.0.1", "192.0.2.5"]) {
      expect(isPrivateOrReserved(ip), ip).toBe(true);
    }
  });
  it("公网 IPv4 → false（含 192.0.66/24 等 192.0.x 公网，仅 192.0.0/24 与 192.0.2/24 才保留）", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "151.101.1.69", "192.0.66.2", "192.0.78.20"]) {
      expect(isPrivateOrReserved(ip), ip).toBe(false);
    }
  });
  it("IPv6 环回 / ULA / 链路本地 / v4-mapped 私有 → true，公网 v6 → false", () => {
    expect(isPrivateOrReserved("::1")).toBe(true);
    expect(isPrivateOrReserved("fc00::1")).toBe(true);
    expect(isPrivateOrReserved("fe80::1")).toBe(true);
    expect(isPrivateOrReserved("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrReserved("2606:4700:4700::1111")).toBe(false);
  });
  it("非法 IP → true（按不安全处理）", () => {
    expect(isPrivateOrReserved("not-an-ip")).toBe(true);
    expect(isPrivateOrReserved("999.1.1.1")).toBe(true);
  });
});

describe("readTextCapped 大小封顶", () => {
  afterEach(() => vi.restoreAllMocks());

  it("未超限 → 返回全文", async () => {
    const text = await readTextCapped(streamResponse(["abc", "def", "ghij"]), 100);
    expect(text).toBe("abcdefghij");
  });

  it("超限默认抛错（不传 truncate）", async () => {
    // 块累计：3→6→10，maxBytes=8 在第三块触顶
    await expect(readTextCapped(streamResponse(["abc", "def", "ghij"]), 8)).rejects.toThrow(/超过上限 8 字节/);
  });

  it("超限 + truncate=true → 截断保留触顶块之前的部分、不抛错、打 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = await readTextCapped(streamResponse(["abc", "def", "ghij"]), 8, { truncate: true, label: "feed-x" });
    expect(text).toBe("abcdef"); // 第三块（使总数=10>8）被丢弃，干净边界
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/已截断保留前 6 字节.*feed-x/);
  });
});

describe("safeFetch 拦截（不触网即拒）", () => {
  it("拒非 http/https 协议", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/协议/);
    await expect(safeFetch("ftp://example.com/x")).rejects.toThrow(/协议/);
  });
  it("拒私有 / 保留 IP 字面量", async () => {
    await expect(safeFetch("http://127.0.0.1/x")).rejects.toThrow(/SSRF/);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/SSRF/);
    await expect(safeFetch("http://10.0.0.5/internal")).rejects.toThrow(/SSRF/);
    await expect(safeFetch("http://[::1]/x")).rejects.toThrow(/SSRF/);
  });
  it("拒非法 URL", async () => {
    await expect(safeFetch("http://")).rejects.toThrow();
  });
});

describe("fetchWithRetry 瞬时退避（切片3a）", () => {
  const URL_PUB = "http://8.8.8.8/feed"; // 公网 IP 字面量 → 绕 DNS，assertPublicHost 直接放行
  const res = (status: number): Response =>
    ({ status, ok: status >= 200 && status < 300, headers: { get: () => null } }) as unknown as Response;
  afterEach(() => vi.restoreAllMocks());

  it("5xx 后成功 → 退避重试、返 200", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry(URL_PUB, {}, [0, 0]);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("抛错（网络/超时）后成功 → 重试、返 200", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry(URL_PUB, {}, [0, 0]);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("4xx → 不重试、直接返", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(404));
    const r = await fetchWithRetry(URL_PUB, {}, [0, 0]);
    expect(r.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("SSRF 拦截 → 不重试、立即抛（fetch 都没调）", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await expect(fetchWithRetry("http://127.0.0.1/x", {}, [0, 0])).rejects.toThrow(/SSRF/);
    expect(f).not.toHaveBeenCalled();
  });

  it("持续 5xx → 重试用尽后返最后的 5xx（attempts=3）", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(503));
    const r = await fetchWithRetry(URL_PUB, {}, [0, 0]);
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(3); // 1 + 2 重试
  });

  it("持续抛错 → 重试用尽后抛", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    await expect(fetchWithRetry(URL_PUB, {}, [0, 0])).rejects.toThrow(/timeout/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("非瞬时错误（命中 NON_TRANSIENT）→ 立即抛、不重试（红线：改文案漏更新 regex 即退化为误重试）", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("重定向次数过多"));
    await expect(fetchWithRetry(URL_PUB, {}, [0, 0])).rejects.toThrow(/重定向次数过多/);
    expect(f).toHaveBeenCalledTimes(1); // 没重试
  });
});
