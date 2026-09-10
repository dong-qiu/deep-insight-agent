import { describe, expect, it } from "vitest";
import { NOOP_P1_TELEMETRY_SINK } from "../lib/capabilities/p1-telemetry.js";
import { SQLITE_P1_TELEMETRY_SINK } from "../lib/capabilities/p1-telemetry-sqlite.js";
import { p1TelemetrySinkForApp } from "./p1-telemetry-composition.js";

describe("P1 telemetry app composition", () => {
  it("injects SQLite only for a non-production P1-dev app", () => {
    expect(p1TelemetrySinkForApp({ P1_LIFECYCLE: "dev" })).toBe(SQLITE_P1_TELEMETRY_SINK);
    expect(p1TelemetrySinkForApp({ NODE_ENV: "production", P1_LIFECYCLE: "dev" }))
      .toBe(NOOP_P1_TELEMETRY_SINK);
  });
});
