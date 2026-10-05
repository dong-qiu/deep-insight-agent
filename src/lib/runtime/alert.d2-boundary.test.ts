import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import * as facade from "./alert.js";
import * as channels from "./alert-channels.js";

afterEach(() => { vi.doUnmock("./email.js"); vi.doUnmock("./logger.js"); vi.doUnmock("./diagnostics.js"); });

it("keeps all original public helpers as the same function references", () => {
  expect(facade.detectChannel).toBe(channels.detectChannel);
  expect(facade.buildAlertRequest).toBe(channels.buildAlertRequest);
  expect(facade.appLevelError).toBe(channels.appLevelError);
});

it("the channel entry loads without email/logger/diagnostic dependencies", async () => {
  vi.resetModules();
  for (const dependency of ["./email.js", "./logger.js", "./diagnostics.js"]) {
    vi.doMock(dependency, () => { throw new Error(`channel entry imported ${dependency}`); });
  }
  const entry = await import("./alert-channels.js");
  expect(entry.detectChannel("https://ntfy.sh/synthetic")).toBe("ntfy");
});

it("fresh native channel import does not read app configuration or call clock/random/transport", () => {
  const url = new URL("./alert-channels.ts", import.meta.url).href;
  // Native Node TS loading avoids counting the test runner/transpiler's own activity.
  const script = `
    const reads = [];
    process.env = new Proxy(process.env, { get(target, key) {
      if (/^(ALERT_|REPORT_|BRIEF_|SMTP_|DB_PATH$|DATA_DIR$|LOG_LEVEL$)/.test(String(key))) reads.push(key);
      return target[key];
    } });
    const forbidden = () => { throw new Error("unexpected import side effect"); };
    Date.now = forbidden;
    Math.random = forbidden;
    globalThis.fetch = forbidden;
    const entry = await import(${JSON.stringify(url)});
    if (reads.length || typeof entry.buildAlertRequest !== "function") throw new Error("unexpected module initialization");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
