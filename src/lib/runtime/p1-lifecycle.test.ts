import { describe, expect, it } from "vitest";
import { NOOP_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../capabilities/p1-telemetry-sqlite.js";
import { p1Lifecycle, p1TelemetrySinkForRuntime } from "./p1-lifecycle.js";

describe("P1 lifecycle composition", () => {
  it("defaults to dormant and injects no telemetry writer", () => {
    expect(p1Lifecycle({})).toBe("dormant");
    expect(p1TelemetrySinkForRuntime({})).toBe(NOOP_P1_TELEMETRY_SINK);
  });

  it("permits the SQLite observer only in non-production P1-dev", () => {
    expect(p1Lifecycle({ P1_LIFECYCLE: "dev" })).toBe("dev");
    expect(p1TelemetrySinkForRuntime({ P1_LIFECYCLE: "dev" })).toBe(SQLITE_P1_TELEMETRY_SINK);
    expect(p1Lifecycle({ NODE_ENV: "production", P1_LIFECYCLE: "dev" })).toBe("dormant");
    expect(p1TelemetrySinkForRuntime({ NODE_ENV: "production", P1_LIFECYCLE: "dev" })).toBe(NOOP_P1_TELEMETRY_SINK);
  });
});
