import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const command = ["--import", "tsx", "evals/a1-status.ts"];
it("reads legacy artifacts without loading env, exposing source data or inventing timing", () => {
  const root = mkdtempSync(join(tmpdir(), "c4a-status-")); roots.push(root);
  const path = join(root, "manifest.json");
  writeFileSync(path, JSON.stringify({ status: "completed", auto_gate: "pass", baseline_comparison: "incomparable", config: { secret: "PRIVATE-SOURCE-TEXT" } }));
  const value = execFileSync(process.execPath, [...command, path], { encoding: "utf8", env: { ...process.env, LLM_PROVIDER: "INVALID-PRIVATE-PROVIDER" } });
  expect(JSON.parse(value)).toEqual({ execution: "completed", automatic_gate: "pass", baseline: "incomparable", timing: null });
  expect(value).not.toContain("PRIVATE");
});
it("distinguishes no execution from unreadable explicit artifacts without logging their path", () => {
  expect(JSON.parse(execFileSync(process.execPath, command, { encoding: "utf8" })).execution).toBe("not_run");
  const result = spawnSync(process.execPath, [...command, "/PRIVATE-SOURCE-TEXT/nonexistent-manifest"], { encoding: "utf8" });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("A1 status: artifact_unreadable\n");
});

it("does not interpret a literal null artifact as no run", () => {
  const root = mkdtempSync(join(tmpdir(), "c4a-status-")); roots.push(root);
  const path = join(root, "manifest.json"); writeFileSync(path, "null");
  const result = spawnSync(process.execPath, [...command, path], { encoding: "utf8" });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("A1 status: artifact_unreadable\n");
});
