import { describe, expect, it } from "vitest";
import { decodeMetricDetailCursor, encodeMetricDetailCursor } from "./metric-detail-cursor.js";

describe("metric detail cursor", () => {
  const cursor = { cursor_version: 1 as const, kind: "funnel" as const, from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", as_of: "2026-08-02T00:00:00.000Z", occurred_at: "2026-08-01T01:00:00.000Z", id: "event_1" };

  it("round-trips the API and page continuation contract", () => {
    expect(decodeMetricDetailCursor(encodeMetricDetailCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed, oversized, and unsupported cursor shapes", () => {
    expect(decodeMetricDetailCursor("not-a-cursor")).toBeNull();
    expect(decodeMetricDetailCursor("x".repeat(2049))).toBeNull();
    expect(decodeMetricDetailCursor(Buffer.from(JSON.stringify({ ...cursor, kind: "unknown" })).toString("base64url"))).toBeNull();
  });
});
