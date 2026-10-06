import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const baselineCommit = "1d8925f7559bc648a2be288f2e9977336a4e0d17";
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function loadFrozenD3(trial = false) {
  mkdirSync(".cache", { recursive: true });
  const directory = mkdtempSync(resolve(".cache", "d3-frozen-"));
  try {
    const originalHashes: Record<string, string> = {};
    let trialPatchHash: string | undefined;
    if (trial) {
      const staging = join(directory, "src/lib/db");
      mkdirSync(staging, { recursive: true });
      for (const name of ["analysis", "graph"]) {
        writeFileSync(join(staging, `${name}.ts`), execFileSync("git", ["show", `${baselineCommit}:src/lib/db/${name}.ts`]));
      }
      const patch = readFileSync("evals/fixtures/d3-citation-batch.patch");
      trialPatchHash = digest(patch);
      // Applies only to our ignored temporary source tree. Production source is never modified.
      execFileSync("git", ["apply", `--directory=${directory.replace(`${process.cwd()}/`, "")}`, "--"], { input: patch });
    }
    const transformedHashes: Record<string, string> = {};
    const importMapping: Record<string, string> = {};
    for (const name of ["analysis", "graph"]) {
      const path = `src/lib/db/${name}.ts`;
      const source = execFileSync("git", ["show", `${baselineCommit}:${path}`], { encoding: "utf8" });
      originalHashes[path] = digest(source);
      const input = trial ? readFileSync(join(directory, `src/lib/db/${name}.ts`), "utf8") : source;
      const transformed = input.replace(/from "(\.[^"]+)"/g, (full, relative: string) => {
        const target = name === "graph" && relative === "./analysis.js"
          ? join(directory, "analysis.ts") : resolve(dirname(resolve(path)), relative.replace(/\.js$/, ".ts"));
        importMapping[`${path}:${relative}`] = target.includes(directory) ? "frozen/analysis.ts" : target.replace(`${process.cwd()}/`, "");
        return full.replace(relative, target);
      });
      transformedHashes[path] = digest(transformed);
      writeFileSync(join(directory, `${name}.ts`), transformed);
    }
    const sharedHashes: Record<string, string> = {};
    for (const path of ["src/lib/db/reader-evidence.ts", "src/lib/db/integrity-lifecycle.ts", "src/lib/db/redaction.ts",
      "src/lib/utils/display-coverage-audit.ts", "src/lib/utils/source-quote-projection.ts", "src/lib/db/schema.ts", "src/lib/utils/reader-visible-entities.ts", "src/lib/graph/cooccurrence.ts",
      "src/lib/graph/entity-normalize.ts", "src/lib/runtime/text-normalize.ts", "src/lib/runtime/statement-fingerprint.ts", "src/lib/sources/normalize.ts"]) {
      const expected = execFileSync("git", ["show", `${baselineCommit}:${path}`]);
      const current = readFileSync(path);
      if (!expected.equals(current)) throw new Error(`D3 shared source drift: ${path}`);
      sharedHashes[path] = digest(current);
    }
    const graph = await import(pathToFileURL(join(directory, "graph.ts")).href) as typeof import("../../src/lib/db/graph.js");
    return { graph, directory, identity: { baselineCommit, trialPatchHash, originalHashes, transformedHashes, importMapping, sharedHashes } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
