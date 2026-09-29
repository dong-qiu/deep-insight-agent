// Read-only backup verification. Never opens the live SQLite database.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const MANIFEST = "backup-manifest.json";
const MAX_RESTORE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function withinRestoreWindow(createdAt, now) {
  const at = Date.parse(createdAt);
  const age = now.getTime() - at;
  return Number.isFinite(at) && age >= 0 && age < MAX_RESTORE_AGE_MS;
}

function stampTime(name) {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return NaN;
  const time = Date.UTC(...match.slice(1).map(Number).map((n, i) => i === 1 ? n - 1 : n));
  if (!Number.isFinite(time)) return NaN;
  const iso = new Date(time).toISOString();
  const normalized = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return normalized === name ? time : NaN;
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : null;
}

function safeRelative(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(`${prefix}/`)) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
  return parts.join(sep);
}

function hasDotSegment(value) {
  return value.split(/[\\/]/).some((part) => part === "." || part === "..");
}

function rawPath(ref, dataDir) {
  if (typeof ref !== "string" || !ref) return null;
  if (ref.startsWith("raw/")) return safeRelative(ref, "raw");
  if (!isAbsolute(ref) || hasDotSegment(ref)) return null; // Historical .data/raw refs are not an asserted volume mapping.
  const rel = within(resolve(dataDir, "raw"), resolve(ref));
  return rel ? join("raw", rel) : null;
}

function reportPaths(bodyPath, dataDir) {
  if (typeof bodyPath !== "string" || !isAbsolute(bodyPath) || hasDotSegment(bodyPath)) return null;
  const rel = within(resolve(dataDir, "reports"), resolve(bodyPath));
  if (!rel || rel.endsWith(".md") || rel.endsWith(".html")) return null;
  return [join("reports", `${rel}.md`), join("reports", `${rel}.html`)];
}

function regularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function fileHash(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally { closeSync(fd); }
  return { size, sha256: hash.digest("hex") };
}

function listedFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === MANIFEST) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("backup_symlink_forbidden");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full).split(sep).join("/"));
      else throw new Error("backup_special_file_forbidden");
    }
  }
  walk(root);
  return files.sort();
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", name);
}

/** Inventory the backup snapshot and every DB reference without touching live data. */
export function inspectBackup(backupDir, dataDir = "/data") {
  const root = resolve(backupDir);
  const dbPath = join(root, "insight.db");
  if (!regularFile(dbPath)) throw new Error("backup_db_missing");
  const files = listedFiles(root).map((name) => ({ path: name, ...fileHash(join(root, name)) }));
  const fileMap = new Map(files.map((file) => [file.path, file]));
  const summary = {
    sqlite_ok: false,
    references_total: 0,
    references_present: 0,
    references_missing: 0,
    references_unmapped: 0,
    embedded_hash_mismatch: 0,
    files: files.length,
  };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    summary.sqlite_ok = db.pragma("quick_check", { simple: true }) === "ok";
    if (!summary.sqlite_ok) return { summary, files, complete: false };
    const referenced = [];
    const addRaw = (ref) => {
      summary.references_total++;
      const rel = rawPath(ref, dataDir);
      if (rel) referenced.push(rel);
      else summary.references_unmapped++;
    };
    const addReport = (bodyPath) => {
      summary.references_total += 2;
      const paths = reportPaths(bodyPath, dataDir);
      if (paths) referenced.push(...paths);
      else summary.references_unmapped += 2;
    };
    for (const row of db.prepare("SELECT raw_ref,speaker_map_status,speaker_map_ref FROM content_item").iterate()) {
      addRaw(row.raw_ref);
      if (row.speaker_map_status === "verified") addRaw(row.speaker_map_ref);
    }
    for (const row of db.prepare("SELECT body_path FROM report WHERE status = ?").iterate("done")) {
      addReport(row.body_path);
    }
    if (hasTable(db, "transcript_acquisition_fact")) {
      for (const row of db.prepare("SELECT raw_ref FROM transcript_acquisition_fact WHERE evidence_status = ?").iterate("verified")) addRaw(row.raw_ref);
    }
    if (hasTable(db, "integrity_report_lifecycle")) {
      for (const row of db.prepare("SELECT artifact_body_path FROM integrity_report_lifecycle WHERE reader_state IN (?,?)").iterate("delete_pending", "purge_pending")) {
        addReport(row.artifact_body_path);
      }
    }
    for (const rel of referenced) {
      const key = rel.split(sep).join("/");
      const file = fileMap.get(key);
      if (!file) { summary.references_missing++; continue; }
      summary.references_present++;
      const digest = basename(rel).match(/\.([a-f0-9]{64})\.txt$/)?.[1];
      if (digest && digest !== file.sha256) summary.embedded_hash_mismatch++;
    }
  } finally { db.close(); }
  return {
    summary,
    files,
    complete: summary.sqlite_ok && summary.references_missing === 0 && summary.references_unmapped === 0
      && summary.embedded_hash_mismatch === 0,
  };
}

export function writeBackupManifest(backupDir, dataDir = "/data", { rawIncluded = true } = {}) {
  const inventory = inspectBackup(backupDir, dataDir);
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    raw_included: rawIncluded,
    status: inventory.complete && rawIncluded ? "complete" : "incomplete",
    summary: inventory.summary,
    files: inventory.files,
  };
  writeFileSync(join(backupDir, MANIFEST), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

export function verifyBackup(backupDir, dataDir = "/data", now = new Date()) {
  const manifestPath = join(backupDir, MANIFEST);
  if (!regularFile(manifestPath)) return { complete: false, reason: "manifest_missing" };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { complete: false, reason: "manifest_invalid" }; }
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files) || !manifest.summary
    || typeof manifest.raw_included !== "boolean" || !["complete", "incomplete"].includes(manifest.status)) {
    return { complete: false, reason: "manifest_invalid" };
  }
  if (!withinRestoreWindow(manifest.created_at, now)) return { complete: false, reason: "backup_outside_restore_window" };
  try {
    const actual = inspectBackup(backupDir, dataDir);
    if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files)
      || JSON.stringify(actual.summary) !== JSON.stringify(manifest.summary)) {
      return { complete: false, reason: "manifest_mismatch", summary: actual.summary };
    }
    const complete = actual.complete && manifest.raw_included && manifest.status === "complete";
    return { complete, reason: complete ? null : !manifest.raw_included ? "raw_excluded" : actual.complete ? "manifest_declares_incomplete" : "references_incomplete", summary: actual.summary };
  } catch {
    return { complete: false, reason: "backup_check_failed" };
  }
}

/** Retain the newest manifest-declared complete snapshot in addition to the rolling window. */
export function planBackupPrune(backupRoot, keep, dataDir = "/data", now = new Date()) {
  const names = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  // Legacy snapshots have no C1 manifest and may have been placed here manually.
  // Never delete them implicitly; they require an explicit operator inventory.
  const managed = names.filter((name) => {
    try {
      const manifest = JSON.parse(readFileSync(join(backupRoot, name, MANIFEST), "utf8"));
      return manifest?.schema_version === 1 && Array.isArray(manifest.files)
        && typeof manifest.raw_included === "boolean"
        && ["complete", "incomplete"].includes(manifest.status)
        && Number.isFinite(Date.parse(manifest.created_at));
    }
    catch { return false; }
  });
  const inWindow = managed.filter((name) => {
    const age = now.getTime() - stampTime(name);
    if (!Number.isFinite(age) || age < 0 || age >= MAX_RESTORE_AGE_MS) return false;
    try {
      const manifest = JSON.parse(readFileSync(join(backupRoot, name, MANIFEST), "utf8"));
      return withinRestoreWindow(manifest.created_at, now);
    } catch { return false; }
  });
  const retained = new Set(inWindow.slice(0, keep));
  for (const name of inWindow) {
    try {
      const manifest = JSON.parse(readFileSync(join(backupRoot, name, MANIFEST), "utf8"));
      if (manifest?.schema_version === 1 && manifest.raw_included === true && manifest.status === "complete"
        && verifyBackup(join(backupRoot, name), dataDir, now).complete) {
        retained.add(name);
        break;
      }
    } catch { /* Legacy or malformed manifests are not asserted complete. */ }
  }
  return managed.filter((name) => !retained.has(name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const backupDir = args[args.indexOf("--backup-dir") + 1];
  const dataDir = args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : "/data";
  if (!backupDir || backupDir.startsWith("--") || !dataDir || dataDir.startsWith("--")) {
    console.error("用法：node ops/backup-integrity.mjs --backup-dir <隔离备份目录> [--data-dir <原数据根路径>]");
    process.exitCode = 2;
  } else {
    const result = verifyBackup(backupDir, dataDir);
    console.log(JSON.stringify(result));
    if (!result.complete) process.exitCode = 2;
  }
}
