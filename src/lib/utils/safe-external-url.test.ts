import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./safe-external-url.js";

describe("safeExternalUrl", () => {
  it("keeps ordinary http(s) source URLs navigable", () => {
    expect(safeExternalUrl("https://example.test/research?a=1#section")).toBe("https://example.test/research?a=1#section");
    expect(safeExternalUrl(" http://example.test/article ")).toBe("http://example.test/article");
  });

  it("does not turn an untrusted stored scheme or malformed value into a link", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,unsafe")).toBeNull();
    expect(safeExternalUrl("not a URL")).toBeNull();
    expect(safeExternalUrl("https://example.test/" + "a".repeat(300))).toBeNull();
  });
});
