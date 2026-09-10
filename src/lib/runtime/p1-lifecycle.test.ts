import { describe, expect, it } from "vitest";
import { p1Lifecycle } from "./p1-lifecycle.js";

describe("P1 lifecycle composition", () => {
  it("defaults to dormant", () => {
    expect(p1Lifecycle({})).toBe("dormant");
  });

  it("permits P1-dev only outside production", () => {
    expect(p1Lifecycle({ P1_LIFECYCLE: "dev" })).toBe("dev");
    expect(p1Lifecycle({ NODE_ENV: "production", P1_LIFECYCLE: "dev" })).toBe("dormant");
  });
});
