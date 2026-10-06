import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ mode: "none", created: "" }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
    if (fault.mode === "git" || (fault.mode === "apply" && args[1]?.[0] === "apply")) throw new Error("synthetic_git_failure");
    return original.execFileSync(...args);
  } };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, mkdtempSync: (...args: Parameters<typeof original.mkdtempSync>) => {
    const directory = original.mkdtempSync(...args);
    fault.created = String(directory);
    return directory;
  }, readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
    if (fault.mode === "drift" && args[0] === "src/lib/db/reader-evidence.ts") return Buffer.from("synthetic drift");
    return original.readFileSync(...args);
  } };
});
import { loadFrozenD3 } from "./fixtures/d3-frozen.js";

it.each(["git", "apply", "drift"])("cleans only its newly created source directory on %s failure and preserves the error", async mode => {
  mkdirSync(".cache", { recursive: true });
  const existing = mkdtempSync(".cache/d3-failure-sentinel-");
  fault.created = "";
  fault.mode = mode;
  try {
    await expect(loadFrozenD3(mode === "apply")).rejects.toThrow(mode === "drift" ? "D3 shared source drift" : "synthetic_git_failure");
    expect(fault.created).not.toBe("");
    expect(existsSync(fault.created)).toBe(false);
    expect(existsSync(existing)).toBe(true);
  } finally { fault.mode = "none"; rmSync(existing, { recursive: true, force: true }); }
});
