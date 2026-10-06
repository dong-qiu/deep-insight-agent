// Explicit maintenance command, never an install hook. Reproduce into a NEW directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const url = "https://registry.npmjs.org/magicast/-/magicast-0.5.5.tgz";
const integrity = "sha512-UicdXN8zQ3JHlxVq+28afMXPr1z7WNY6+7EJnzTdQWkTAlMLF5fNCCKxJHBQwGaNGR11581EiQmQzx73+MvszA==";
const chunk = "dist/builders-CDdrUKLb.js";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const output = process.argv[2] && resolve(process.argv[2]);
assert.ok(output && !existsSync(output), "Supply a new output directory; existing files are never overwritten");
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
assert.ok(response.ok, "upstream download failed");
const archive = Buffer.from(await response.arrayBuffer());
assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, integrity);
const temporary = mkdtempSync(join(tmpdir(), "insight-magicast-vendor-"));
try {
  const archivePath = join(temporary, "upstream.tgz");
  writeFileSync(archivePath, archive);
  const members = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trim().split("\n");
  const read = path => execFileSync("tar", ["-xOf", archivePath, `package/${path}`], { maxBuffer: 2 * 1024 * 1024 });
  const metadata = JSON.parse(read("package.json"));
  assert.equal(metadata.version, "0.5.5");
  assert.equal(metadata.inlinedDependencies["source-map-js"], "1.2.1");
  const paths = members.filter(path => /^package\/dist\/[A-Za-z0-9_.-]+$/.test(path)).map(path => path.slice(8)).sort();
  assert.equal(paths.length, 8);
  const files = {};
  const provenance = { upstream: url, integrity, modified: chunk, files: {} };
  for (const path of ["LICENSE", ...paths]) {
    const original = read(path);
    let bytes = original;
    if (path === chunk) {
      assert.equal(digest(original), "6d589e4c1b4c89141d67698af6750c470184c575553029c80b110e8e091d553c", "upstream builders chunk changed");
      const code = original.toString("utf8");
      const start = code.indexOf("//#region node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js\n");
      const end = code.indexOf("\nconst n$2 = namedTypes$1;", start);
      assert.ok(start > 0 && end > start, "upstream module boundaries changed");
      assert.equal(code.slice(start, end).match(/\/\/#region node_modules\/\.pnpm\/source-map-js@1\.2\.1\//g)?.length, 10);
      bytes = Buffer.from('import * as import_source_map from "source-map-js";\n' + code.slice(0, start) + "//#region vendor/recast/lib/util.ts" + code.slice(end));
      assert.ok(!/require_source_map_|IndexedSourceMapConsumer|source-map-js@1\.2\.1|new Function\(/.test(bytes.toString()), "old source-map implementation remains");
    }
    files[path] = bytes;
    provenance.files[path] = { upstream_sha256: digest(original), patched_sha256: digest(bytes) };
  }
  const patchedMetadata = {
    name: "magicast", version: "0.5.5-insight.1", private: true,
    description: "magicast 0.5.5 with its inline source-map-js replaced by official 1.2.2",
    type: metadata.type, license: metadata.license, repository: metadata.repository,
    sideEffects: metadata.sideEffects, exports: metadata.exports, main: metadata.main,
    module: metadata.module, types: metadata.types, files: ["dist", "LICENSE", "PROVENANCE.json", "SECURITY_PATCH.md"],
    dependencies: { ...metadata.dependencies, "source-map-js": "1.2.2" },
    inlinedDependencies: { recast: metadata.inlinedDependencies.recast },
  };
  files["package.json"] = Buffer.from(JSON.stringify(patchedMetadata, null, 2) + "\n");
  files["PROVENANCE.json"] = Buffer.from(JSON.stringify(provenance, null, 2) + "\n");
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(output, path)), { recursive: true });
    writeFileSync(join(output, path), bytes, { flag: "wx" });
  }
  console.log("Reproduced magicast 0.5.5; removed all ten inline source-map-js modules; other dist files unchanged");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
