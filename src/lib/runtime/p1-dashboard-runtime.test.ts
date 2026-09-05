import { describe, expect, it } from "vitest";
import { p1DashboardEnabled, p1ExternalSeamsEnabled } from "./p1-dashboard-runtime.js";

describe("p1 dashboard runtime admission", () => {
  it("defaults closed and accepts only strict booleans", () => {
    expect(p1DashboardEnabled({})).toBe(false);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "false" })).toBe(false);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "1" })).toBe(true);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "true" })).toBe(true);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "true " })).toBe(false);
    expect(p1DashboardEnabled({ P1_DASHBOARD_ENABLED: "yes" })).toBe(false);
  });

  it("hard-denies production even if a local environment file requests enablement", () => {
    expect(p1DashboardEnabled({ NODE_ENV: "production", P1_DASHBOARD_ENABLED: "true" })).toBe(false);
    expect(p1ExternalSeamsEnabled({ NODE_ENV: "production", P1_DASHBOARD_ENABLED: "true" })).toBe(false);
  });
});
