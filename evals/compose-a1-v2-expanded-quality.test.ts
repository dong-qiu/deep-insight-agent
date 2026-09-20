import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function line(topicId: string, items: Array<{ id: string; url: string }>) {
  return JSON.stringify({ topic: { id: topicId }, items });
}

function write(root: string, name: string, lines: string[]) {
  const path = join(root, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "evals/compose-a1-v2-expanded-quality.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

describe("expanded controlled A1 quality composition", () => {
  it("replaces only the platform topic and preserves base topic order", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-compose-")); roots.push(root);
    const base = write(root, "base.local.jsonl", [
      line("t_code_agents", [{ id: "code-1", url: "https://example.test/code-1" }]),
      line("t_coding_agent_platforms", [{ id: "old-platform", url: "https://example.test/old" }]),
      line("t_agent_security", [{ id: "security-1", url: "https://example.test/security-1" }]),
    ]);
    const expansion = write(root, "platform.local.jsonl", [line("t_coding_agent_platforms", [
      { id: "platform-1", url: "https://example.test/platform-1" },
      { id: "platform-2", url: "https://example.test/platform-2" },
    ])]);
    const out = join(root, "expanded.local.jsonl");

    const result = run(base, expansion, out);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8").trim().split("\n")[1]!).items).toEqual([
      { id: "platform-1", url: "https://example.test/platform-1" },
      { id: "platform-2", url: "https://example.test/platform-2" },
    ]);
    expect(result.stdout).toContain("3 个 topic、4 条");
  });

  it("rejects a duplicate introduced by the replacement before writing output", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-compose-")); roots.push(root);
    const base = write(root, "base.local.jsonl", [
      line("t_code_agents", [{ id: "shared", url: "https://example.test/shared" }]),
      line("t_coding_agent_platforms", [{ id: "old-platform", url: "https://example.test/old" }]),
    ]);
    const expansion = write(root, "platform.local.jsonl", [line("t_coding_agent_platforms", [{ id: "platform-1", url: "https://example.test/shared" }])]);
    const out = join(root, "expanded.local.jsonl");

    const result = run(base, expansion, out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("重复 content id 或 URL");
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  it("rejects ambiguous input and refuses to overwrite an existing candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-compose-")); roots.push(root);
    const base = write(root, "base.local.jsonl", [line("t_coding_agent_platforms", [{ id: "old", url: "https://example.test/old" }])]);
    const ambiguous = write(root, "platform.local.jsonl", [
      line("t_coding_agent_platforms", [{ id: "one", url: "https://example.test/one" }]),
      line("t_code_agents", [{ id: "two", url: "https://example.test/two" }]),
    ]);
    const out = join(root, "expanded.local.jsonl");
    expect(run(base, ambiguous, out).stderr).toContain("只能包含");

    const valid = write(root, "valid-platform.local.jsonl", [line("t_coding_agent_platforms", [{ id: "one", url: "https://example.test/one" }])]);
    writeFileSync(out, "existing\n");
    const overwrite = run(base, valid, out);
    expect(overwrite.status).toBe(2);
    expect(overwrite.stderr).toContain("拒绝覆盖");
    expect(readFileSync(out, "utf8")).toBe("existing\n");
  });
});
