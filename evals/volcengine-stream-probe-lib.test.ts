import { describe, expect, it } from "vitest";
import {
  VOLCENGINE_STREAM_PROBE_PROFILES,
  probeAttemptsPerProfile,
  probePassed,
  safeProbeErrorType,
  safeProbeHttpStatus,
  selectProbeProfiles,
  summarizeProbeProfile,
  syntheticProbeInput,
} from "./volcengine-stream-probe-lib.js";

describe("Volcengine stream probe helpers", () => {
  it("bounds the live request count before any provider request is made", () => {
    expect(probeAttemptsPerProfile(undefined)).toBe(3);
    expect(probeAttemptsPerProfile("1")).toBe(1);
    expect(probeAttemptsPerProfile("10")).toBe(10);
    expect(() => probeAttemptsPerProfile("11")).toThrow("VOLCENGINE_STREAM_PROBE_ATTEMPTS");
  });

  it("creates exact-length synthetic input without source material", () => {
    const input = syntheticProbeInput(1_024);
    expect(input).toHaveLength(1_024);
    expect(input).toContain("Synthetic transport-only context");
  });

  it("keeps expensive escalation profiles opt-in", () => {
    expect(selectProbeProfiles(undefined).map((profile) => profile.id)).toEqual([
      "short_256", "coverage_1024", "coverage_2048",
    ]);
    expect(selectProbeProfiles("short_4096,short_8192").map((profile) => profile.maxTokens)).toEqual([4_096, 8_192]);
    expect(() => selectProbeProfiles("unknown")).toThrow("未知的 VOLCENGINE_STREAM_PROBE_PROFILE_IDS");
  });

  it("summarizes only bounded protocol metadata", () => {
    const summary = summarizeProbeProfile(VOLCENGINE_STREAM_PROBE_PROFILES[2]!, [
      { profile_id: "coverage_2048", duration_ms: 10 },
      {
        profile_id: "coverage_2048",
        duration_ms: 30,
        failure: {
          error_type: "VolcengineResponsesError",
          terminal: "eof_before_terminal",
          http_status: 503,
          saw_done: true,
          function_arguments_done: true,
        },
      },
    ]);
    expect(summary).toMatchObject({
      attempts: 2,
      successes: 1,
      failures: 1,
      latency_ms: { p50: 10, p95: 30, max: 30 },
      terminal_events: { eof_before_terminal: 1 },
      http_statuses: { 503: 1 },
      saw_done: { true: 1 },
      function_arguments_done: { true: 1 },
    });
    expect(probePassed([summary])).toBe(true);
    expect(probePassed([{ ...summary, successes: 0, failures: 2 }])).toBe(false);
    expect(probePassed([])).toBe(false);
  });

  it("does not serialize mutable error metadata as a probe category", () => {
    const mutable = Object.assign(new Error("credential=secret"), { name: "token=secret" });
    expect(safeProbeErrorType(mutable)).toBe("UnknownError");
    expect(safeProbeHttpStatus(503)).toBe(503);
    expect(safeProbeHttpStatus(999)).toBeUndefined();
  });
});
