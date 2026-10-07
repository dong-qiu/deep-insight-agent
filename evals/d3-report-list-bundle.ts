/** Build an authentic offline ReportsPage; only its connection provider is injected. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReactElement } from "react";
import { digest } from "./fixtures/d3-report-list.js";

export const repo = fileURLToPath(new URL("../", import.meta.url));
const runtime = resolve(repo, "evals/d3-report-list-runtime.ts");
export type Page = (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
export async function bundlePage(directory: string, diagnostic: boolean) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outfile = resolve(directory, diagnostic ? "observed.mjs" : "plain.mjs");
  const rewrites: Array<{ path: string; originalHash: string; transformedHash: string; replacements: number }> = [];
  function exact(source: string, from: string, to: string, count = 1) {
    assert.equal(source.split(from).length - 1, count, `source shape changed: ${from}`);
    return source.replaceAll(from, to);
  }
  const result = await build({ absWorkingDir: repo, entryPoints: ["src/app/reports/page.tsx"], outfile,
    bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", metafile: true,
    plugins: [{ name: "isolated-report-list", setup(b) {
      b.onResolve({ filter: /db\/index\.js$/ }, args => args.importer === resolve(repo, "src/app/reports/page.tsx")
        ? { path: "isolated-connection", namespace: "d3" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "d3" }, () => ({ contents: `export { benchmarkDb as getDb } from ${JSON.stringify(runtime)};`, loader: "ts" }));
      b.onResolve({ filter: /d3-report-list-runtime\.ts$/ }, () => ({ path: runtime, external: true }));
      if (diagnostic) b.onLoad({ filter: /(?:page\.tsx|reports\.ts|integrity-lifecycle\.ts|redaction\.ts)$/ }, args => {
        const path = relative(repo, args.path);
        if (!["src/app/reports/page.tsx", "src/lib/db/reports.ts", "src/lib/db/integrity-lifecycle.ts", "src/lib/db/redaction.ts"].includes(path)) return;
        const original = readFileSync(args.path, "utf8");
        let source = original, replacements = 0;
        const replace = (from: string, to: string, n = 1) => { source = exact(source, from, to, n); replacements += n; };
        if (path.endsWith("page.tsx")) {
          for (const name of ["listTopics", "listSources"]) replace(`${name}(db)`, `measure("${name}", () => ${name}(db))`);
          for (const column of ["source_ids", "tags", "entity_names"]) replace(`distinctIndexValues(db, "${column}")`, `measure("facet:${column}", () => distinctIndexValues(db, "${column}"))`);
          const call = "queryReportIndex(db, { q, type, domain, lens, topic, source, tag, entity, from, to, sort, dir })";
          replace(call, `measure("queryReportIndex", () => ${call})`);
        } else if (path.endsWith("reports.ts")) {
          replace(".map(rowToIndex)", '.map(row => measure("rowToIndex", () => rowToIndex(row)))', 3);
        } else {
          const name = path.endsWith("redaction.ts") ? "reportRedactionVisibilitySql" : "reportReaderVisibilitySql";
          replace(`export function ${name}(`, `function original_${name}(`);
          source += `\nexport function ${name}(db: DB, column: string): string { return measure("${name}", () => original_${name}(db, column)); }\n`;
        }
        source = `import { measure } from ${JSON.stringify(runtime)};\n${source}`;
        rewrites.push({ path, originalHash: digest(original), transformedHash: digest(source), replacements });
        return { contents: source, loader: path.endsWith(".tsx") ? "tsx" : "ts" };
      });
    } }],
  });
  const sources = Object.fromEntries(Object.keys(result.metafile.inputs).filter(path => !path.startsWith("d3:")).sort()
    .map(path => [path, digest(readFileSync(resolve(repo, path)))]));
  const identity = { diagnostic, sources, rewrites: rewrites.sort((a, b) => a.path.localeCompare(b.path)), bundleHash: digest(readFileSync(outfile)) };
  writeFileSync(resolve(directory, `${diagnostic ? "observed" : "plain"}-identity.json`), JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  const pageModule = await import(pathToFileURL(outfile).href) as { default: Page };
  return { page: pageModule.default, identity, outfile, directory: dirname(outfile) };
}
