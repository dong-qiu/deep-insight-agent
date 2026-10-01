import { describe, expect, it } from "vitest";
import { safeError, redactDiagnostic, redactDiagnosticText } from "./diagnostics.js";

describe("diagnostic information boundary", () => {
  it("drops opaque message, stack, cause and SDK payload, keeping only status", () => {
    const err = Object.assign(new Error("opaque-private-example"), {
      status: 429, cause: new Error("private-cause-example"), body: "private-response-example",
    });
    expect(safeError(err)).toEqual({ type: "Error", message: "http_error_429" });
    expect(safeError(safeError(err))).toEqual(safeError(err));
    expect(JSON.stringify(redactDiagnostic({ err }))).not.toMatch(/opaque-private|private-cause|private-response|stack/);
  });
  it("classifies common failures but never changes or rethrows the original", () => {
    const err = Object.assign(new Error("private"), { code: "SQLITE_BUSY" });
    expect(safeError(err).message).toBe("sqlite_busy");
    expect(err.message).toBe("private");
    expect(safeError({ cause: { code: "ECONNRESET" } }).message).toBe("transport_connection");
    expect(safeError("opaque-private-example")).toEqual({ type: "Error", message: "operation_failed" });
    expect(safeError(null).message).toBe("operation_failed");
    expect(safeError(new Error("no_releasable_insight")).message).toBe("no_releasable_insight");
    for (const name of ["QuoteCoverageAuditError", "QuoteCoverageRejectedError"]) {
      expect(safeError(Object.assign(new Error("opaque-private-example"), { name }))).toEqual({ type: name, message: "operation_failed" });
    }
  });
  it("redacts recursive credentials and payload fields without mutating input", () => {
    const input = { stage: "collect", nested: [{ child: { Authorization: "sensitive-a", API_KEY: "sensitive-b", body: "opaque-private-example" } }], count: 2 };
    const output = JSON.stringify(redactDiagnostic(input));
    expect(output).not.toMatch(/sensitive-|opaque-private/);
    expect(output).toContain("collect"); expect(output).toContain('"count":2');
    expect(input.nested[0].child.API_KEY).toBe("sensitive-b");
  });
  it("redacts free-text credential syntax and URLs before truncation", () => {
    const text = 'request https://user:pass@example.test/hook/private-path?token=private-query#private-fragment Authorization: Bearer private-bearer password="private-password" email=alice@example.test';
    const result = redactDiagnosticText(text);
    expect(result).not.toMatch(/private-|user:pass|alice@/);
    expect(result).toContain("example.test");
    expect(redactDiagnosticText("-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----")).not.toContain("private-material");
    expect(redactDiagnosticText("x".repeat(20_000))).not.toContain("xxxx");
  });
  it("fails closed on cycles, deep objects and hostile getters", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => JSON.stringify(redactDiagnostic(cycle))).not.toThrow();
    const hostile = { get message(): never { throw new Error("private-getter"); } };
    expect(safeError(hostile).message).toBe("operation_failed");
    expect(JSON.stringify(redactDiagnostic(hostile))).not.toContain("private-getter");
  });
});
