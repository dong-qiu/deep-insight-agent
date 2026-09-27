import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle.js";

describe("login admission budgets", () => {
  it("permits five attempts, blocks even repeated attempts, and recovers at the original deadline", () => {
    const limiter = new LoginThrottle();
    for (let i = 0; i < 5; i++) expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1)).toBe(false);
    expect(limiter.take("a", 59_999)).toBe(false);
    expect(limiter.take("a", 60_000)).toBe(true);
  });

  it("clears only the successful account, never the global password-check budget", () => {
    const limiter = new LoginThrottle();
    for (let i = 0; i < 5; i++) expect(limiter.take("blocked", 0)).toBe(true);
    for (let i = 0; i < 55; i++) {
      expect(limiter.take("successful", 0)).toBe(true);
      limiter.succeeded("successful");
    }
    expect(limiter.take("blocked", 0)).toBe(false);
    expect(limiter.take("new", 0)).toBe(false);
    expect(limiter.take("successful", 0)).toBe(false);
    expect(limiter.take("new", 60_000)).toBe(true);
  });

  it("stops rotating accounts at 60 checks", () => {
    const limiter = new LoginThrottle();
    for (let i = 0; i < 60; i++) expect(limiter.take(String(i), 0)).toBe(true);
    expect(limiter.take("sixty-one", 0)).toBe(false);
  });

  it("does not charge the global check budget for already blocked accounts", () => {
    const limiter = new LoginThrottle();
    for (let i = 0; i < 5; i++) limiter.take("a", 0);
    for (let i = 0; i < 100; i++) expect(limiter.take("a", 10)).toBe(false);
    for (let i = 0; i < 55; i++) expect(limiter.take(String(i), 10)).toBe(true);
    expect(limiter.take("last", 10)).toBe(false);
  });

  it("bounds memory without evicting live buckets; expiry frees capacity", () => {
    const limiter = new LoginThrottle({ maxAccounts: 2 });
    for (let i = 0; i < 5; i++) limiter.take("a", 0);
    expect(limiter.take("b", 1)).toBe(true);
    expect(limiter.take("c", 2)).toBe(false);
    expect(limiter.take("a", 2)).toBe(false);
    expect(limiter.take("c", 60_000)).toBe(true);
    expect(limiter.take("b", 60_000)).toBe(true);
  });

  it.each([0, -1, 1.1, NaN, Infinity])("rejects invalid capacity %s", (maxAccounts) => {
    expect(() => new LoginThrottle({ maxAccounts })).toThrow();
  });
});
