import { describe, expect, it } from "vitest";
import { isAdminOnlyPath } from "./role-paths.js";

describe("isAdminOnlyPath（多账号分权闸门）", () => {
  it("管理/配置面 → admin only", () => {
    for (const p of ["/admin", "/admin/", "/settings", "/api/admin/sources", "/api/admin/topics/t1", "/api/admin/runs/r1/retry"]) {
      expect(isAdminOnlyPath(p)).toBe(true);
    }
  });

  it("烧钱端点（深挖/追问/PPT）→ admin only", () => {
    expect(isAdminOnlyPath("/api/topics/t_abc/deep-dive")).toBe(true);
    expect(isAdminOnlyPath("/api/topics/t_abc/deep-dive/status")).toBe(true); // 进度轮询同限
    expect(isAdminOnlyPath("/api/reports/rep_1/followup")).toBe(true);
    expect(isAdminOnlyPath("/api/reports/rep_1/pptx")).toBe(true);
  });

  it("viewer 可读路径 → 非 admin-only", () => {
    for (const p of ["/", "/reports", "/reports/rep_1", "/topics", "/topics/t1", "/api/reports", "/api/health"]) {
      expect(isAdminOnlyPath(p)).toBe(false);
    }
  });

  it("不把 /api/reports 列表误判成烧钱端点（仅 followup/pptx 子路径才限）", () => {
    expect(isAdminOnlyPath("/api/reports")).toBe(false);
    expect(isAdminOnlyPath("/api/reports/rep_1")).toBe(false); // 详情读取（实际无此 api，但语义上读取不该被限）
  });

  it("前缀不误伤相邻名（/settingsX 不算 /settings）", () => {
    expect(isAdminOnlyPath("/settings-help")).toBe(false);
    expect(isAdminOnlyPath("/adminish")).toBe(false);
  });
});
