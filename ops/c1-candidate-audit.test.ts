import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCandidate, sourceEntry, verifiedFile, sha256, audit, assertStandaloneSnapshot } from "./c1-candidate-audit";
import { contentHash } from "../src/lib/sources/normalize";
import Database from "better-sqlite3";

const entry = { title: "Example", link: "https://example.test/item", description: "<p>Historical body</p>", pubDate: "2026-09-30T00:00:00Z" };
const row = { id: "ci_example", url: entry.link, title: entry.title, published_at: "2026-09-30T00:00:00.000Z", body: "Historical body", content_hash: contentHash("Historical body"), body_kind: "article" };

function fixture(verdict = "pass", archivedEntry: unknown = entry) {
  const root = mkdtempSync(join(tmpdir(), "c1-integrated-test-"));
  const candidate = join(root, "candidates");
  mkdirSync(join(candidate, ".data/raw"), { recursive: true });
  const path = ".data/raw/ci_example.txt";
  const raw = JSON.stringify(archivedEntry); writeFileSync(join(candidate, path), raw);
  const dbPath = join(root, "snapshot.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE content_item(id TEXT,url TEXT,title TEXT,published_at TEXT,body TEXT,content_hash TEXT,body_kind TEXT,raw_ref TEXT);
    CREATE TABLE report(id TEXT,status TEXT,title TEXT,insight_ids TEXT,citation_count INTEGER);
    CREATE TABLE insight(id TEXT,batch_id TEXT);
    CREATE TABLE citation(insight_id TEXT,content_item_id TEXT,citation_index INTEGER,quote TEXT);
    CREATE TABLE citation_check(batch_id TEXT,insight_id TEXT,citation_index INTEGER,verdict TEXT,reachability TEXT,consistency TEXT);`);
  db.prepare("INSERT INTO content_item VALUES(?,?,?,?,?,?,?,?)").run(row.id,row.url,row.title,row.published_at,row.body,row.content_hash,row.body_kind,path);
  db.exec(`INSERT INTO report VALUES('rep_example','done','Example','["ins_example"]',1);
    INSERT INTO insight VALUES('ins_example','batch_example');
    INSERT INTO citation VALUES('ins_example','ci_example',0,'Historical body');
    INSERT INTO citation_check VALUES('batch_example','ins_example',0,'pass','pass','support');`);
  db.prepare("UPDATE citation_check SET verdict=?").run(verdict);
  db.close();
  const dbBytes = readFileSync(dbPath);
  const backup = JSON.stringify({ files: [{ path: "insight.db", size: dbBytes.length, sha256: sha256(dbBytes) }] });
  const backupPath = join(root, "backup.json"); writeFileSync(backupPath, backup);
  const files = [{ path, size: Buffer.byteLength(raw), sha256: sha256(raw), kind: "raw" }];
  mkdirSync(join(candidate, ".data/reports"));
  const report = "# Example\nHistorical body";
  const reportPath = ".data/reports/rep_example.md";
  writeFileSync(join(candidate, reportPath), report);
  files.push({ path: reportPath, size: Buffer.byteLength(report), sha256: sha256(report), kind: "report" });
  const manifestPath = join(root, "manifest.json");
  function args(scope = "all", changedFiles = files, backupHash = sha256(backup)) {
    const manifest = JSON.stringify({ source_backup_manifest_sha256: backupHash, files: changedFiles });
    writeFileSync(manifestPath, manifest);
    return [candidate, manifestPath, sha256(manifest), dbPath, backupPath, scope, join(root, "output.json")];
  }
  return { root, candidate, dbPath, files, args };
}

describe("C1 candidate audit boundaries", () => {
  it("does not authenticate historical bytes even when all content fields match", () => {
    expect(compareCandidate(entry, row)).toMatchObject({ identity: true, body_reproduced: true, db_body_hash_valid: true, historical_byte_identity: "unproven" });
  });
  it.each(["url", "title", "published_at"] as const)("rejects an identity match with different %s", field => {
    expect(compareCandidate(entry, { ...row, [field]: field === "published_at" ? "2025-09-30T00:00:00Z" : "different" }).identity).toBe(false);
  });
  it("keeps body provenance gaps separate from identity matches", () => {
    expect(compareCandidate({ ...entry, description: "Different body" }, row)).toMatchObject({ identity: true, body_reproduced: false, historical_byte_identity: "unproven" });
  });
  it.each(["", "not-a-date"])("does not equate an absent/invalid date with a null snapshot date", pubDate => {
    expect(compareCandidate({ ...entry, pubDate }, { ...row, published_at: null })).toMatchObject({ identity: false, date_known: false });
  });
  it("detects a corrupted database body hash", () => {
    expect(compareCandidate(entry, { ...row, content_hash: sha256(JSON.stringify(entry)) }).db_body_hash_valid).toBe(false);
  });
  it("reports alternate truncation order without promoting it to a current-body or byte match", () => {
    const html = "<p>".repeat(16_666) + "  body";
    expect(compareCandidate({ ...entry, description: html }, { ...row, body: "", content_hash: contentHash("") })).toMatchObject({
      body_reproduced: false, pre_strip_cap_reproduced: true, historical_byte_identity: "unproven",
    });
  });
  it("parses Atom while refusing unknown objects as source text", () => {
    expect(sourceEntry({ id: entry.link, title: { "#text": "Example" }, content: "Body", published: entry.pubDate, link: { "@_href": entry.link, "@_rel": "alternate" } }).url).toBe(entry.link);
    expect(() => sourceEntry({ title: {}, link: {}, description: {} })).toThrow();
  });
  it("verifies bytes and rejects hash mismatch, traversal and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "c1-audit-test-"));
    try {
      mkdirSync(join(root, ".data/raw"), { recursive: true });
      const path = ".data/raw/ci_test.txt";
      writeFileSync(join(root, path), "body");
      const file = { path, size: 4, sha256: sha256("body") };
      expect(verifiedFile(root, file).toString()).toBe("body");
      expect(() => verifiedFile(root, { ...file, sha256: sha256("other") })).toThrow("hash/size");
      expect(() => verifiedFile(root, { ...file, path: "../outside.txt" })).toThrow("unsafe");
      symlinkSync(join(root, path), join(root, ".data/raw/ci_link.txt"));
      expect(() => verifiedFile(root, { ...file, path: ".data/raw/ci_link.txt" })).toThrow("symlink");
    } finally { rmSync(root, { recursive: true }); }
  });
  it("requires explicit inputs instead of opening the live database", () => {
    expect(() => audit([])).toThrow("usage:");
  });
  it("rejects WAL-mode headers and sidecars before SQLite opens", () => {
    const root = mkdtempSync(join(tmpdir(), "c1-snapshot-test-"));
    const path = join(root, "snapshot.db");
    const bytes = Buffer.alloc(100);
    bytes.write("SQLite format 3\0"); bytes[18] = 1; bytes[19] = 1;
    try {
      writeFileSync(path, bytes);
      expect(() => assertStandaloneSnapshot(path, bytes)).not.toThrow();
      const wal = Buffer.from(bytes); wal[18] = 2;
      expect(() => assertStandaloneSnapshot(path, wal)).toThrow("standalone");
      writeFileSync(path + "-wal", "uncommitted");
      expect(() => assertStandaloneSnapshot(path, bytes)).toThrow("standalone");
    } finally { rmSync(root, { recursive: true }); }
  });
  it("rejects an unauthenticated candidate manifest before database access", () => {
    const root = mkdtempSync(join(tmpdir(), "c1-manifest-test-"));
    try {
      const path = join(root, "manifest.json"); writeFileSync(path, "{}");
      expect(() => audit([root, path, sha256("other"), "absent.db", "absent-manifest.json", "all", join(root, "result.json")])).toThrow("manifest hash");
    } finally { rmSync(root, { recursive: true }); }
  });
  it.each(["pilot", "all"])("runs the real %s database path read-only and writes a private non-overwritable result", scope => {
    const f = fixture();
    try {
      const args = f.args(scope); const before = sha256(readFileSync(f.dbPath));
      expect(audit(args)).toMatchObject({ raw_examined: 1, identity_matches: 1, historical_bytes_authenticated: 0, restore_approved: false });
      expect(sha256(readFileSync(f.dbPath))).toBe(before);
      expect(statSync(args[6]).mode & 0o777).toBe(0o600);
      const output = readFileSync(args[6]).toString();
      expect(output).not.toContain(entry.link); expect(output).not.toContain(row.body);
      expect(JSON.parse(output).reports[0]).toMatchObject({ stored_citation_count: 1, snapshot_pass_citations: 1,
        literal_quotes_present: 1, normalized_quotes_present: 1, historical_byte_identity: "unproven" });
      expect(() => audit(args)).toThrow("EEXIST");
    } finally { rmSync(f.root, { recursive: true }); }
  });
  it("does not select blocked report citations in the pilot", () => {
    const f = fixture("blocked");
    try { expect(audit(f.args("pilot"))).toMatchObject({ raw_examined: 0, identity_matches: 0 }); }
    finally { rmSync(f.root, { recursive: true }); }
  });
  it("records unknown archives instead of treating them as matches", () => {
    const f = fixture("pass", { unsupported: true });
    try {
      const args = f.args(); expect(audit(args)).toMatchObject({ raw_examined: 1, identity_matches: 0 });
      expect(JSON.parse(readFileSync(args[6]).toString()).raw[0].error).toBe("unrecognized_archive");
    } finally { rmSync(f.root, { recursive: true }); }
  });
  it("rejects duplicate and unlisted files and broken backup linkage on the complete CLI path", () => {
    const f = fixture();
    try {
      expect(() => audit(f.args("all", [...f.files, ...f.files]))).toThrow("duplicate");
      expect(() => audit(f.args("all", f.files, sha256("bad backup")))).toThrow("linkage");
      writeFileSync(join(f.candidate, ".data/raw/ci_extra.txt"), "extra");
      expect(() => audit(f.args())).toThrow("unlisted");
    } finally { rmSync(f.root, { recursive: true }); }
  });
});
