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

  it("covers final serialization, child bindings, formatting and opaque Error payloads", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => lines.push(s) });
    const child = log.child({ run_id: "run_test", deeply: [{ headers: { Authorization: "private-header" } }] });
    child.error({ err: Object.assign(new Error("opaque-private-message"), { cause: new Error("opaque-private-cause") }), payload: { toJSON: () => ({ API_KEY: "private-json-key" }) } }, "password=%s", "private-format-password");
    const output = lines.join("");
    expect(output).not.toMatch(/private-|opaque-private/);
    expect(output).toContain("run_test");
    expect(JSON.parse(lines[0]).err.message).toBe("operation_failed");
  });

  it("sanitizes structured formatting arguments before percent interpolation", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => lines.push(s) });
    log.warn("request failed: %j", { body: "opaque-private-request", headers: { Cookie: "a=private-one; b=private-two" } });
    log.error("failure: %s", new Error("opaque-private-error"));
    expect(lines.join("")).not.toMatch(/opaque-private|private-one|private-two/);
  });

  it("covers credential/body aliases while retaining numeric usage telemetry", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => lines.push(s) });
    const fields = ["SMTP_PASS", "smtp_pass", "requestBody", "responseBody", "rawBody", "promptText"];
    log.info({ ...Object.fromEntries(fields.map((key) => [key, `synthetic-private-${key}`])), tokens: 123, input_tokens: 45, output_tokens: 78 });
    log.info({ tokens: "synthetic-private-token" }, "Cookie: one=synthetic-private-one; two=synthetic-private-two");
    expect(lines.join("")).not.toContain("synthetic-private");
    expect(JSON.parse(lines[0])).toMatchObject({ tokens: 123, input_tokens: 45, output_tokens: 78 });
  });

  it("protects child/setBindings before Error toJSON or custom serializers can erase its type", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => lines.push(s) });
    const error = Object.assign(new Error("synthetic-private-error"), {
      toJSON: () => ({ message: "synthetic-private-json" }),
    });
    const child = log.child({ failure: error, run_id: "run_child" });
    child.info("child");
    const grandchild = child.child({ failure: error }, { serializers: { failure: (e) => ({ type: e.type, message: e.message }) } });
    grandchild.setBindings({ laterFailure: error, responseBody: "synthetic-private-response" });
    grandchild.info({ err: Object.assign(new Error("synthetic-private-network"), { code: "ECONNRESET" }) }, "grandchild");
    log.setBindings({ rootFailure: error });
    log.info("root");
    expect(lines.join("")).not.toContain("synthetic-private");
    expect(JSON.parse(lines[0])).toMatchObject({ run_id: "run_child", failure: { message: "operation_failed" } });
    expect(JSON.parse(lines[1])).toMatchObject({ run_id: "run_child", failure: { message: "operation_failed" }, laterFailure: { message: "operation_failed" }, err: { message: "transport_connection" } });
    expect(JSON.parse(lines[2])).toMatchObject({ rootFailure: { message: "operation_failed" } });
    expect(error.message).toBe("synthetic-private-error");
  });
});
