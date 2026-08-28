import { describe, expect, it } from "vitest";
import { deterministicUuidV5 } from "./uuid.js";

describe("deterministicUuidV5", () => {
  it("matches the RFC 4122 DNS namespace test vector", () => {
    expect(deterministicUuidV5("www.widgets.com")).toBe("21f7f8de-8051-5b89-8680-0195ef798b6a");
  });

  it("keeps an application-owned name stable", () => {
    expect(deterministicUuidV5("p1-metric-fact:received:trace-1")).toBe(deterministicUuidV5("p1-metric-fact:received:trace-1"));
  });
});
