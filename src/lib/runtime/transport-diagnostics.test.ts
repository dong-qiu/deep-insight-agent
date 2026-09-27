import { describe, expect, it } from "vitest";
import { classifyTransportFailure } from "./transport-diagnostics.js";

describe("bounded transport failure diagnostics", () => {
  it.each([
    ["ENOTFOUND", "transport_dns"], ["EAI_AGAIN", "transport_dns"],
    ["CERT_HAS_EXPIRED", "transport_tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "transport_tls"],
    ["ECONNRESET", "transport_connection"], ["UND_ERR_SOCKET", "transport_connection"],
    ["UND_ERR_CONNECT_TIMEOUT", "transport_timeout"], ["UND_ERR_BODY_TIMEOUT", "transport_timeout"],
    ["UND_ERR_CLOSED", "transport_client_closed"], ["UND_ERR_DESTROYED", "transport_client_closed"],
    ["UND_ERR_INVALID_ARG", "transport_invalid_argument"],
  ])("classifies nested %s without exporting private fields", (code, expected) => {
    const error = new TypeError("fetch failed", { cause: new Error("private-host-and-key", { cause: { code, address: "private-host" } }) });
    expect(classifyTransportFailure(error)).toBe(expected);
  });
  it("handles AggregateError and cycles within a bounded traversal", () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(classifyTransportFailure(new TypeError("fetch failed", {
      cause: new AggregateError([cycle, { code: "ECONNREFUSED" }]),
    }))).toBe("transport_connection");
    expect(classifyTransportFailure(cycle)).toBeUndefined();
  });
  it.each(["private-secret", "constructor", "__proto__", "toString"])("does not persist unrecognized code %s", (code) => {
    expect(classifyTransportFailure(new TypeError("fetch failed", { cause: { code } }))).toBe("transport_unknown");
    expect(classifyTransportFailure({ code, message: "private-secret" })).toBeUndefined();
  });
  it("distinguishes cancellation and deadline without treating schema errors as transport", () => {
    expect(classifyTransportFailure(new DOMException("private", "TimeoutError"))).toBe("transport_timeout");
    expect(classifyTransportFailure(new DOMException("private", "AbortError"))).toBe("transport_aborted");
    expect(classifyTransportFailure(new Error("schema failed"))).toBeUndefined();
  });
});
