import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

// Keep hostile maps out of the test runner: older dependency behavior can block
// synchronously or exhaust memory. The OS can kill each dedicated child.
function probe(body) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", `
    const assert = require("node:assert/strict");
    const { SourceMapConsumer, SourceMapGenerator, SourceNode } = require("source-map-js");
    const flat = { version: 3, sources: ["a.js"], sourcesContent: ["a"], names: [], mappings: "AAAA" };
    const indexed = (map, line, column = 0) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
    ${body}
  `], { cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

test("indexed maps reject invalid offsets and cumulative nested line overflow", () => {
  probe(`
    for (const value of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      assert.throws(() => new SourceMapConsumer(indexed(flat, value)), /non-negative integers/);
      assert.throws(() => new SourceMapConsumer(indexed(flat, 0, value)), /non-negative integers/);
    }
    assert.throws(() => new SourceMapConsumer(indexed(flat, 1e7 + 1)), /must not exceed/);
    assert.throws(() => new SourceMapConsumer(indexed(indexed(flat, 5e6), 5e6 + 1)), /including offsets of nested sections/);
    const consumer = new SourceMapConsumer(indexed(indexed(flat, 5e6), 5e6));
    const lines = [];
    consumer.eachMapping(mapping => lines.push(mapping.generatedLine));
    assert.deepEqual(lines, [1e7 + 1]);
  `);
});

test("SourceNode handles offsets beyond generated code and deep indexed maps", () => {
  probe(`
    const code = "var x;\\n";
    assert.equal(code.charCodeAt(code.length - 1), 10);
    const node = SourceNode.fromStringWithSourceMap(code, new SourceMapConsumer(indexed(flat, 1e7)));
    assert.equal(node.toString(), code);
    assert.ok(node.children.length < 10);
    let map = flat;
    for (let depth = 0; depth < 40; depth++) map = indexed(map, 0);
    const nested = SourceNode.fromStringWithSourceMap(code, new SourceMapConsumer(map));
    assert.equal(nested.toString(), code);
    const contents = {};
    nested.walkSourceContents((source, content) => { contents[source] = content; });
    assert.deepEqual(contents, { "a.js": "a" });
  `);
});

test("generator serializes the maximum accepted section gap within bounded heap", () => {
  probe(`
    const consumer = new SourceMapConsumer(indexed(flat, 1e7));
    const generator = new SourceMapGenerator();
    consumer.eachMapping(mapping => generator.addMapping({
      generated: { line: mapping.generatedLine, column: mapping.generatedColumn },
      original: { line: mapping.originalLine, column: mapping.originalColumn },
      source: mapping.source,
    }));
    const mappings = generator.toJSON().mappings;
    assert.equal(mappings.length, 1e7 + 4);
    assert.equal(mappings.slice(-5), ";AAAA");
  `);
});

test("actual PostCSS previous-map path rejects hostile maps and preserves valid mapping", () => {
  probe(`
    const postcss = require("postcss");
    const css = "a { color: red; }";
    const processMap = prev => postcss().process(css, {
      from: "input.css", to: "output.css", map: { prev, inline: false, annotation: false },
    });
    assert.throws(() => processMap(indexed(flat, 1e7 + 1)).map, /must not exceed/);
    const valid = processMap(flat);
    assert.equal(valid.css, css);
    const position = new SourceMapConsumer(valid.map.toJSON()).originalPositionFor({ line: 1, column: 0 });
    assert.equal(position.source, "a.js");
    assert.equal(position.line, 1);
    assert.equal(position.column, 0);
  `);
});

test("installed quick-sort works when VM string code generation is disabled", () => {
  probe(`
    const { readFileSync } = require("node:fs");
    const vm = require("node:vm");
    const context = vm.createContext({ exports: {} }, { codeGeneration: { strings: false, wasm: false } });
    // Exercise the upstream CSP fallback with the installed, unmodified module.
    vm.runInContext(readFileSync(require.resolve("source-map-js/lib/quick-sort.js"), "utf8"), context);
    vm.runInContext('const numbers = [3, 1, 2]; exports.quickSort(numbers, (a, b) => a - b); exports.sorted = JSON.stringify(numbers);', context);
    assert.equal(context.exports.sorted, "[1,2,3]");
  `);
});

test("installed magicast public API rejects hostile inputSourceMap and retains normal maps", () => {
  probe(`
    const { parseModule, generateCode } = require("magicast");
    const code = "export default { enabled: true };";
    const mod = parseModule(code, { sourceFileName: "a.js" });
    const generate = inputSourceMap => generateCode(mod, { sourceMapName: "out.js.map", inputSourceMap });
    for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      assert.throws(() => generate(indexed(flat, value)), /non-negative integers/);
      assert.throws(() => generate(indexed(flat, 0, value)), /non-negative integers/);
    }
    assert.throws(() => generate(indexed(flat, 1e7 + 1)), /must not exceed/);
    assert.throws(() => generate(indexed(indexed(flat, 5e6), 5e6 + 1)), /including offsets of nested sections/);
    const output = generate(flat);
    assert.equal(output.code, code);
    const position = new SourceMapConsumer(output.map).originalPositionFor({ line: 1, column: 0 });
    assert.equal(position.source, "a.js");
    assert.equal(position.line, 1);
    assert.equal(position.column, 0);
    const edited = parseModule(code);
    edited.exports.default.enabled = false;
    assert.equal(generateCode(edited).code, "export default { enabled: false };");
  `);
});

test("installed magicast uses the reviewed vendor bytes with no old inline source-map code", () => {
  probe(`
    const { readFileSync } = require("node:fs");
    const { dirname, join } = require("node:path");
    const { createHash } = require("node:crypto");
    const parent = require("@vitest/coverage-v8/package.json");
    assert.equal(parent.version, "5.0.1", "review vendor compatibility before updating the coverage parent");
    assert.equal(parent.dependencies.magicast, "^0.5.4");
    const directory = dirname(dirname(require.resolve("magicast")));
    const provenance = JSON.parse(readFileSync(join(directory, "PROVENANCE.json"), "utf8"));
    for (const [file, hashes] of Object.entries(provenance.files)) {
      const bytes = readFileSync(join(directory, file));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes.patched_sha256);
      if (file !== provenance.modified) assert.equal(hashes.upstream_sha256, hashes.patched_sha256);
    }
    const bundle = readFileSync(join(directory, provenance.modified), "utf8");
    assert.match(bundle, /import \\* as import_source_map from "source-map-js"/);
    assert.doesNotMatch(bundle, /require_source_map_|IndexedSourceMapConsumer|source-map-js@1\\.2\\.1|new Function\\(/);
  `);
});
