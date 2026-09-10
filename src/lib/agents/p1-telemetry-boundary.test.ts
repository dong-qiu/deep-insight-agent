/** Keep P1's SQLite implementation out of the P0 agent-core import graph. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ["p1-telemetry-sqlite", "p1-metrics-pipeline", "p1-metrics-facts"];
const ENTRYPOINTS = ["scheduler.ts", "collector.ts", "pipeline.ts", "generation-dispatch.ts"];

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  return candidates.find(existsSync);
}

function importedFiles(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(file, "utf8");
  const files = [file];
  for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) continue;
    const dependency = resolveModule(file, specifier);
    if (dependency) files.push(...importedFiles(dependency, seen));
  }
  return files;
}

describe("P0 agent-core telemetry boundary", () => {
  it("never statically reaches the SQLite P1 adapter or metrics modules", () => {
    const graph = ENTRYPOINTS.flatMap((entry) => importedFiles(resolve(AGENTS_DIR, entry)));
    const violations = graph.filter((file) => FORBIDDEN.some((name) => file.includes(name)));
    expect(violations).toEqual([]);
  });
});
