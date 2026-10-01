import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** One inventory for local tests and CI coverage; do not follow directory symlinks. */
export function discoverNodeTests(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".node-test.mjs")) files.push(relative(root, path));
    }
  }
  visit(join(root, "ops"));
  if (files.length === 0) throw new Error("No ops Node tests discovered");
  return files.sort();
}

export function runNodeTests(root, spawn = spawnSync) {
  const result = spawn(process.execPath, ["--test", ...discoverNodeTests(root)], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runNodeTests(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
