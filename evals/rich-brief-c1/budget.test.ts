import { afterEach, describe, expect, it, vi } from "vitest";
import { ShadowRequestBudget, type RequestReservation } from "./budget.js";

const hash = "a".repeat(64);
const request = (id: string, tokens = 6, cost = "6"): RequestReservation => ({ request_id: id, operation: "extractor", input_sha256: hash, ceiling_evidence_sha256: hash, token_ceiling: tokens, usd_micros_ceiling: cost });
const instances: ShadowRequestBudget[] = [];
const budget = (arm = "A") => {
  const value = new ShadowRequestBudget({ arm_id: arm, frozen_protocol_sha256: hash, max_requests: 3, max_tokens: 10, max_usd_micros: "10", max_elapsed_ms: 100 });
  instances.push(value); return value;
};
afterEach(() => { instances.forEach((value) => value.close()); instances.length = 0; vi.useRealTimers(); });

describe("shadow request reservations", () => {
  it("reserves concurrent/unfinished requests before dispatch and keeps failure sticky", () => {
    const value = budget(); value.reserve(request("first"));
    expect(() => value.reserve(request("retry"))).toThrow("token_limit");
    value.settle("first", { status: "known", tokens: 1, usd_micros: "1", receipt_sha256: hash });
    expect(() => value.reserve(request("late", 1, "1"))).toThrow("token_limit");
    expect(value.snapshot().requests).toHaveLength(1);
  });
  it("counts SDK retries as separate requests and releases only evidenced savings", () => {
    const value = budget(); value.reserve(request("original"));
    value.settle("original", { status: "known", tokens: 2, usd_micros: "2", receipt_sha256: hash });
    value.reserve(request("retry", 8, "8"));
    expect(value.snapshot().reserved_or_known_usd_micros).toBe("10");
    expect(() => value.reserve(request("extra", 0, "1"))).toThrow("cost_limit");
  });
  it("retains unknown failed billing at the ceiling and refuses further spending", () => {
    const value = budget(); value.reserve(request("failed"));
    expect(() => value.settle("failed", { status: "unknown", reason: "timeout_without_receipt" })).toThrow("unknown_charge_or_usage");
    expect(value.snapshot()).toMatchObject({ unknown_requests: 1, reserved_or_known_usd_micros: "6", status: "stopped" });
    expect(() => value.reserve(request("retry", 1, "1"))).toThrow("unknown_charge_or_usage");
  });
  it("marks an incomplete terminal receipt unknown and stops even if its error is caught", () => {
    const value = budget(); value.reserve(request("dispatched", 1, "1"));
    expect(() => value.settle("dispatched", { status: "known", tokens: 1, usd_micros: "1" } as never)).toThrow("unknown_charge_or_usage");
    expect(value.snapshot()).toMatchObject({ stop_reason: "unknown_charge_or_usage", unknown_requests: 1 });
    expect(value.snapshot().requests[0].settlement).toEqual({ status: "unknown", reason: "invalid_terminal_receipt" });
    expect(value.signal.aborted).toBe(true);
    expect(() => value.reserve(request("after_caught_error", 1, "1"))).toThrow("unknown_charge_or_usage");
  });
  it("keeps arms independent and does not call an empty ledger zero-cost success", () => {
    const a = budget("A"), c1 = budget("C1"); a.reserve(request("a"));
    expect(c1.snapshot()).toMatchObject({ status: "not_executed", requests: [] });
    c1.reserve(request("c1")); expect(c1.snapshot().reserved_or_known_tokens).toBe("6");
  });
  it("rejects rewritten receipts and over-ceiling actual charges", () => {
    const value = budget(); value.reserve(request("one"));
    expect(() => value.settle("one", { status: "known", tokens: 7, usd_micros: "7", receipt_sha256: hash })).toThrow("ceiling_violated");
    expect(() => value.settle("one", { status: "known", tokens: 1, usd_micros: "1", receipt_sha256: hash })).toThrow("rewritten_receipt");
    expect(value.snapshot().reserved_or_known_tokens).toBe("7");
  });
  it("refuses dispatch at the wall-clock deadline even when timer callbacks have not run", () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const value = budget();
    vi.setSystemTime(100);
    expect(() => value.reserve(request("late"))).toThrow("deadline_or_cancelled");
    expect(value.signal.aborted).toBe(true);
  });
  it("uses integer micros and validates supplied ceilings", () => {
    const value = budget(); expect(() => value.reserve(request("bad", 1, "0.1"))).toThrow();
    expect(value.snapshot().requests).toEqual([]);
  });
  it("cannot increase limits or change the protocol after construction", () => {
    const value = budget();
    expect(() => Object.assign(value.limits, { max_tokens: 1000, frozen_protocol_sha256: "b".repeat(64) })).toThrow();
    expect(() => Object.assign(value, { limits: { max_tokens: 1000 } })).toThrow();
    Object.defineProperty(value, "limits", { value: { max_tokens: 1000 } });
    value.reserve(request("one"));
    expect(() => value.reserve(request("two"))).toThrow("token_limit");
    expect(value.snapshot().frozen_protocol_sha256).toBe(hash);
  });
});
