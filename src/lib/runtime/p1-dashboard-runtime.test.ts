import { describe, expect, it } from "vitest";
import { p1DashboardEnabled } from "./p1-dashboard-runtime.js";

describe("p1 dashboard runtime admission", () => {
  it("defaults closed and accepts only strict booleans", () => {
    expect(p1DashboardEnabled({})).toBe(false);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "false" })).toBe(false);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "1" })).toBe(true);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "true" })).toBe(true);
    expect(() => p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "true " })).toThrow("p1_dashboard_enabled_invalid");
    expect(() => p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "yes" })).toThrow("p1_dashboard_enabled_invalid");
  });
});
