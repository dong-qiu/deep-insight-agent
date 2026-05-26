import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger 脱敏", () => {
  it("顶层与嵌套的敏感字段被脱敏，普通字段保留", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => lines.push(s) });
    log.info(
      {
        token: "secret-token-123",
        apiKey: "sk-ant-xxx",
        nested: { authorization: "Bearer abc", cookie: "sid=zzz" },
        topic: "Code Agent",
      },
      "test",
    );
    const out = lines.join("");
    expect(out).not.toContain("secret-token-123");
    expect(out).not.toContain("sk-ant-xxx");
    expect(out).not.toContain("Bearer abc");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("Code Agent"); // 普通字段不脱敏
  });
});
