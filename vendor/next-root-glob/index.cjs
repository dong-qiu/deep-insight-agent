"use strict";
const { globSync: tinyGlobSync, isDynamicPattern } = require("tinyglobby");
const { isAbsolute, resolve, relative, sep } = require("node:path");
const { statSync, readdirSync } = require("node:fs");
const { scan } = require("picomatch");

/** Not a general fast-glob replacement: this is the sole API used by Next 16.3.8 root-dir discovery. */
function globSync(pattern, options) {
  if (typeof pattern !== "string" || !options || options.onlyDirectories !== true ||
      Object.keys(options).some((key) => key !== "onlyDirectories")) {
    throw new TypeError("next-root-glob: unsupported caller contract");
  }
  if (pattern.length > 32768) throw new RangeError("next-root-glob: pattern limit exceeded");
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") { i++; continue; }
    if (pattern[i] === "{" && ++depth > 32) throw new RangeError("next-root-glob: nesting limit exceeded");
    if (pattern[i] === "}") depth = Math.max(0, depth - 1);
  }
  // A literal directory (including symlink) needs no glob parser/crawler at all.
  if (!isDynamicPattern(pattern)) {
    try { return statSync(pattern).isDirectory() ? [pattern.length > 1 ? pattern.replace(/\/$/, "") : pattern] : []; }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return []; throw error; }
  }
  // tinyglobby does not include discovered symlink-directory entries like fast-glob.
  // Refuse that unsupported case rather than silently dropping project lint roots.
  const base = resolve(scan(pattern).base || ".");
  let discoveredSymlink = false;
  let readFailure;
  const checkedRead = (...args) => {
    let entries;
    try { entries = readdirSync(...args); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") readFailure = error; throw error; }
    if (entries.some((entry) => {
      const path = relative(base, resolve(args[0], entry.name));
      return entry.isSymbolicLink() && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
    })) {
      discoveredSymlink = true;
      throw new Error("next-root-glob: symlink discovery unsupported; configure literal roots");
    }
    return entries;
  };
  const paths = tinyGlobSync(pattern, { onlyDirectories: true, expandDirectories: false, absolute: isAbsolute(pattern),
    fs: { readdirSync: checkedRead } });
  // fdir suppresses crawler errors; never turn our unsupported-case refusal into an empty success.
  if (discoveredSymlink) throw new Error("next-root-glob: symlink discovery unsupported; configure literal roots");
  if (readFailure) throw readFailure;
  return paths
    .map((path) => path.length > 1 ? path.replace(/\/$/, "") : path);
}

module.exports = { globSync };
