import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

// Native decoders can crash or block. Keep every probe in its own process,
// with tiny synthetic inputs, bounded pixel counts and an OS-enforced timeout.
function probe(body) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", `
    const assert = require("node:assert/strict");
    const sharp = require("sharp");
    (async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("loaded prebuilt SVG decoder is backed by patched librsvg", () => {
  process.stdout.write(probe(`
    // The rsvg version is the selected prebuilt library's build manifest.
    // Also verify that this process loaded the bundled native library rather
    // than assuming package metadata proves a global library is safe.
    const { realpathSync } = require("node:fs");
    // Linux's $ORIGIN RPATH may retain /lib/../../ segments in the report.
    // Resolve only candidate native paths (the report also has virtual names).
    const sharedObjects = process.report.getReport().sharedObjects
      .filter(path => path.includes("/@img/sharp-"))
      .map(path => realpathSync(path));
    assert.ok(sharedObjects.some(path => /[/]node_modules[/]@img[/]sharp-[^/]+[/]lib[/]sharp-[^/]+\\.node$/.test(path)),
      "expected a loaded prebuilt sharp binding");
    assert.ok(sharedObjects.some(path => /[/]node_modules[/]@img[/]sharp-libvips-[^/]+[/]lib[/]libvips-cpp/.test(path)),
      "expected a loaded bundled libvips; global builds require separate librsvg verification");
    const version = sharp.versions.rsvg;
    assert.match(version ?? "", /^\\d+\\.\\d+\\.\\d+$/);
    const [major, minor, patch] = version.split(".").map(Number);
    assert.ok(major > 2 || (major === 2 && (minor > 63 || (minor === 63 && patch >= 2))),
      "loaded librsvg must be >= 2.63.2; got " + version);
    console.log(JSON.stringify({ sharp: sharp.versions.sharp, vips: sharp.versions.vips, rsvg: version,
      platform: process.platform, arch: process.arch }));
  `));
});

test("real SVG rasterization preserves exact pixels and PNG round trip", () => {
  probe(`
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#ff0000"/></svg>');
    const { data, info } = await sharp(svg, { limitInputPixels: 4 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 2);
    assert.equal(info.height, 2);
    assert.equal(info.channels, 4);
    assert.deepEqual([...data], [255,0,0,255, 255,0,0,255, 255,0,0,255, 255,0,0,255]);
    const png = await sharp(svg, { limitInputPixels: 4 }).png().toBuffer();
    const decoded = await sharp(png, { limitInputPixels: 4 }).ensureAlpha().raw().toBuffer();
    assert.deepEqual(decoded, data);
  `);
});

test("malformed SVG rejects without crashing or hanging the native decoder", () => {
  probe(`
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect></svg>');
    await assert.rejects(sharp(svg, { limitInputPixels: 4 }).raw().toBuffer(), /SVG|xml|corrupt/i);
  `);
});

test("SVG exceeding the input pixel budget is rejected before rasterization", () => {
  probe(`
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2"/></svg>');
    await assert.rejects(sharp(svg, { limitInputPixels: 4 }).raw().toBuffer(), /pixel limit/i);
  `);
});

test("prebuilt WebP encoder and decoder preserve RGBA pixels", () => {
  probe(`
    const pixels = Buffer.from([0,0,0,255, 64,64,64,255, 128,128,128,255, 255,255,255,255]);
    const encoded = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).webp({ lossless: true }).toBuffer();
    const { data, info } = await sharp(encoded, { limitInputPixels: 4 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 2);
    assert.equal(info.height, 2);
    assert.equal(info.channels, 4);
    assert.deepEqual(data, pixels);
  `);
});

test("prebuilt AVIF declarations and codec survive the complete native closure", () => {
  probe(`
    assert.deepEqual(sharp.format.heif.input.fileSuffix, [".avif"]);
    assert.deepEqual(sharp.format.heif.output.alias, ["avif"]);
    const pixels = Buffer.from([0,0,0,255, 64,64,64,255, 128,128,128,255, 255,255,255,255]);
    const encoded = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
      .avif({ lossless: true, effort: 0, chromaSubsampling: "4:4:4" }).toBuffer();
    const { data, info } = await sharp(encoded, { limitInputPixels: 4 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 2);
    assert.equal(info.height, 2);
    assert.equal(info.channels, 4);
    assert.equal(data.length, pixels.length);
    // Permit one level of RGB/YUV rounding; alpha must remain exactly opaque.
    for (let index = 0; index < data.length; index++) {
      if (index % 4 === 3) assert.equal(data[index], pixels[index]);
      else assert.ok(Math.abs(data[index] - pixels[index]) <= 1);
    }
  `);
});
