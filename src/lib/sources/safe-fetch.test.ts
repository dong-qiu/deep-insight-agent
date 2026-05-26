import { describe, expect, it } from "vitest";
import { isPrivateOrReserved, safeFetch } from "./safe-fetch.js";

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
