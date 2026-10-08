import { describe, expect, it } from "vitest";
import { openTerminalDispatchDriver } from "./terminal-dispatch-driver.js";
import { readFileSync } from "node:fs";

// Actual native SQLite and COMMIT faults are exercised by ops/maintenance/terminal.node-test.mjs.
describe("fixed isolated terminal factory boundary", () => {
  it.each([":memory:", "file::memory:?cache=shared", "."])("refuses noncanonical/nonfixture root %s before creating a business connection", root => {
    expect(() => openTerminalDispatchDriver(root)).toThrow();
  });
  it("keeps the reviewed driver and production core free of callback execution and awaits under its locks", () => {
    const source = readFileSync(new URL("./terminal-dispatch-driver.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bawait\b|\basync\b/);
    expect(source).not.toContain("work(");
    // This static boundary complements actual two-process lock/COMMIT/SIGKILL tests, not a safety proof alone.
  });
});
