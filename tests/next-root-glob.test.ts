import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
const pluginDir = dirname(require.resolve("@next/eslint-plugin-next"));
const { getRootDirs } = pluginRequire(join(pluginDir, "utils/get-root-dirs.js")) as {
  getRootDirs(context: { cwd: string; settings: { next?: { rootDir?: unknown } } }): string[];
};
const adapter = pluginRequire("fast-glob") as { globSync(pattern: unknown, options?: unknown): string[] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "next-root-glob-"));
  for (const path of ["web/pages", "web/nested/deeper", "other/pages", ".hidden/pages"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "web/pages/about.js"), "export default function About() {}\n");
  writeFileSync(join(root, "not-a-directory"), "synthetic\n");
  return { root, roots: (rootDir?: unknown) => getRootDirs({ cwd: root, settings: { next: { rootDir } } }),
    cleanup: () => rmSync(root, { recursive: true }) };
}

describe("scoped Next ESLint directory glob security replacement", () => {
  it("resolves the real plugin's dependency to the adapter, not renamed vulnerable code", () => {
    expect(pluginRequire("fast-glob/package.json").name).toBe("@insight-agent/next-root-glob");
    expect(pluginRequire("../package.json").version).toBe("16.3.8");
    const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).some((path) => /node_modules\/(braces|micromatch)$/.test(path))).toBe(false);
    expect(require("../package.json").overrides["@next/eslint-plugin-next@16.3.8"]["fast-glob"]).toBe("$@insight-agent/next-root-glob");
  });
  it("keeps default cwd and literal roots without recursively adding nested directories", () => {
    const f = fixture(); try {
      expect(f.roots()).toEqual([f.root]);
      expect(f.roots(join(f.root, "web"))).toEqual([join(f.root, "web")]);
      expect(f.roots(join(f.root, "web/"))).toEqual([join(f.root, "web")]);
      expect(f.roots(join(f.root, "web").replace(/\//g, "\\"))).toEqual([join(f.root, "web")]);
    } finally { f.cleanup(); }
  });
  it("supports wildcard, brace, array, symlink roots and omits files/hidden/missing entries", () => {
    const f = fixture(); try {
      expect(f.roots(`${f.root}/*`).sort()).toEqual([join(f.root, "other"), join(f.root, "web")]);
      expect(f.roots(`${f.root}/{web,other}`).sort()).toEqual([join(f.root, "other"), join(f.root, "web")]);
      expect(f.roots([join(f.root, "web"), false, `${f.root}/other*`]).sort()).toEqual([join(f.root, "other"), join(f.root, "web")]);
      expect(f.roots(join(f.root, "missing"))).toEqual([]);
      expect(f.roots(join(f.root, "not-a-directory"))).toEqual([]);
      symlinkSync(join(f.root, "web"), join(f.root, "linked"), "dir");
      expect(f.roots(join(f.root, "linked"))).toEqual([join(f.root, "linked")]);
      expect(() => f.roots(`${f.root}/*`)).toThrow("symlink discovery unsupported");
    } finally { f.cleanup(); }
  });
  it("preserves relative root paths and does not add directory descendants", () => {
    const f = fixture(); try {
      const result = spawnSync(process.execPath, ["-e", `const r=require(${JSON.stringify(pluginRequire.resolve("fast-glob"))});process.stdout.write(JSON.stringify(r.globSync("web",{onlyDirectories:true})))`],
        { cwd: f.root, encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(["web"]);
    } finally { f.cleanup(); }
  });
  it("rejects unexpected caller APIs/options rather than silently weakening lint discovery", () => {
    expect(() => adapter.globSync(["src"], { onlyDirectories: true })).toThrow("unsupported caller contract");
    expect(() => adapter.globSync("src", { onlyFiles: true })).toThrow("unsupported caller contract");
    expect(() => adapter.globSync("src", { onlyDirectories: true, dot: true })).toThrow("unsupported caller contract");
  });
  it("propagates directory read failures instead of silently returning no lint roots", () => {
    const f = fixture(); try {
      const result = spawnSync(process.execPath, ["-e", `const fs=require("node:fs");fs.readdirSync=()=>{throw Object.assign(new Error("synthetic denied"),{code:"EACCES"})};const a=require(${JSON.stringify(pluginRequire.resolve("fast-glob"))});try{a.globSync("${f.root}/*",{onlyDirectories:true});process.exit(1)}catch(e){process.stdout.write(e.code||"wrong");}`],
        { cwd: f.root, encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0); expect(result.stdout).toBe("EACCES");
    } finally { f.cleanup(); }
  });
  it("bounds deeply nested and oversized patterns through the actual Next caller", () => {
    const f = fixture(); try {
      expect(() => f.roots("{".repeat(12000) + "x" + "}".repeat(12000))).toThrow("nesting limit exceeded");
      expect(() => f.roots("x".repeat(32769))).toThrow("pattern limit exceeded");
      expect(f.roots(`${f.root}/{web,other}`)).toHaveLength(2);
    } finally { f.cleanup(); }
  });
  it("still detects real Next Link and image lint violations with the production flat config", async () => {
    const f = fixture(); try {
      const eslint = new ESLint({ cwd: f.root, overrideConfigFile: resolve("eslint.config.mjs"),
        overrideConfig: [{ settings: { next: { rootDir: join(f.root, "web") } } }] });
      const [result] = await eslint.lintText('export default function Page() { return <><a href="/about">About</a><img src="/x.png" alt="x" /></>; }',
        { filePath: join(f.root, "web/pages/index.jsx") });
      expect(result.messages.map((message) => message.ruleId)).toContain("@next/next/no-html-link-for-pages");
      expect(result.messages.map((message) => message.ruleId)).toContain("@next/next/no-img-element");
      const [clean] = await eslint.lintText('import Link from "next/link"; export default function Page() { return <Link href="/about">About</Link>; }',
        { filePath: join(f.root, "web/pages/index.jsx") });
      expect(clean.errorCount).toBe(0); expect(clean.warningCount).toBe(0);
    } finally { f.cleanup(); }
  });
});
