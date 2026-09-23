import { describe, expect, it } from "vitest";
import { PUBLIC_PATHS, isPublicPath } from "./auth-paths.js";
import { PROTOTYPE_POLICY } from "./prototype-policy.js";

describe("isPublicPath（middleware 鉴权白名单）", () => {
  it("白名单路径 → true（登录/健康/cron）", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/cron")).toBe(true);
  });

  it("受保护路径 → false（页面与 /api/reports 等）", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/reports")).toBe(false);
    expect(isPublicPath("/reports/rep_xxx")).toBe(false);
    expect(isPublicPath("/settings")).toBe(false);
    expect(isPublicPath("/admin")).toBe(false);
    expect(isPublicPath("/api/reports")).toBe(false);
  });

  it("仅以白名单 + `/` 起头才算白名单子路径，禁止裸前缀误伤", () => {
    expect(isPublicPath("/login/whatever")).toBe(true); // /login/* 视为白名单子路径
    expect(isPublicPath("/loginer")).toBe(false);        // 不是 "/login"、也不是 "/login/..." → false
    expect(isPublicPath("/api/healthcheck")).toBe(false); // 同理：非 "/api/health" 子路径
  });

  it("internal prototype does not make reports or raw-content-like paths public", () => {
    expect(PROTOTYPE_POLICY.audience).toBe("authenticated_users");
    expect(PROTOTYPE_POLICY.raw_content).toBe("admin_only");
    expect(PUBLIC_PATHS).not.toContain("/reports");
    expect(PUBLIC_PATHS).not.toContain("/api/reports");
    for (const path of ["/reports", "/api/reports", "/raw", "/api/raw", "/api/content/raw"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});
