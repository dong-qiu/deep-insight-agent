import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { cpus, availableParallelism } from "node:os";
import { createHash } from "node:crypto";
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
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.length === 3 && process.argv[2] === "--diagnostic-environment") {
    // Passive identity only: do not invoke/prewarm AWS or alter tests/env/cache.
    const read = path => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
    let aws;
    try {
      const path = process.platform === "darwin" ? "/opt/homebrew/bin/aws" : "/usr/local/bin/aws", realpath = realpathSync(path), bytes = readFileSync(realpath);
      aws = { path, realpath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) { aws = { errorCode: error.code }; }
    console.log(JSON.stringify({ schema: "ssm-ci-comparison-v1", observedUTC: new Date().toISOString(), node: process.version,
      cpuCount: cpus().length, availableParallelism: availableParallelism(), cpuMax: read("/sys/fs/cgroup/cpu.max"),
      cpuStat: read("/sys/fs/cgroup/cpu.stat"), memoryMax: read("/sys/fs/cgroup/memory.max"),
      runnerImage: process.env.ImageVersion ?? null, npmSetupCacheHit: process.env.SSM_SETUP_CACHE_HIT || null, aws, files: discoverNodeTests(root),
      cacheState: "Executable bytes read for identity may populate file cache; other page/Python/npm cache state unknown; no extra CLI invocation",
      order: "Sorted file argv and reported test presentation order only; process start order unknown" }));
  } else process.exitCode = runNodeTests(root);
}
