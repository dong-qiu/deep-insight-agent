/** Read-only historical candidate diagnostics. Output is NOT a restore approval. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { normalizeUrl, normalizeBody, contentHash, MAX_BODY_CHARS, MAX_TRANSCRIPT_CHARS } from "../src/lib/sources/normalize.js";
import { parsePublishedAt } from "../src/lib/sources/parse-date.js";

type FileEntry = { path: string; size: number; sha256: string; kind?: string };
type Manifest = { source_backup_manifest_sha256?: string; files: FileEntry[] };
type Row = { id: string; url: string; title: string; published_at: string | null; body: string; content_hash: string; body_kind: string };
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export function assertStandaloneSnapshot(path: string, bytes: Buffer) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || bytes.subarray(0, 16).toString() !== "SQLite format 3\0"
    || bytes[18] !== 1 || bytes[19] !== 1 || existsSync(path + "-wal") || existsSync(path + "-shm")) throw new Error("not a standalone snapshot");
}

function candidatePaths(root: string, relative = ""): string[] {
  if (lstatSync(resolve(root, relative)).isSymbolicLink()) throw new Error("symlink candidate directory");
  return readdirSync(resolve(root, relative), { withFileTypes: true }).flatMap(item => {
    const path = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) return candidatePaths(root, path);
    if (!item.isFile()) throw new Error("non-regular candidate tree entry");
    return [path];
  });
}

export function verifiedFile(root: string, entry: FileEntry): Buffer {
  if (!/^\.data\/(raw|reports)\/[A-Za-z0-9_.-]+$/.test(entry.path)) throw new Error("unsafe candidate path");
  const target = resolve(root, entry.path);
  for (let part = target; part !== resolve(root); part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error("symlink candidate path");
  }
  if (!lstatSync(target).isFile() || !realpathSync(target).startsWith(realpathSync(root) + "/")) throw new Error("non-regular candidate");
  const bytes = readFileSync(target);
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error("candidate hash/size mismatch");
  return bytes;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return text(value["#text"]);
  return "";
}
export function sourceEntry(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unknown source entry");
  const o = value as Record<string, unknown>;
  const atom = typeof o.id === "string";
  const links = Array.isArray(o.link) ? o.link : [o.link];
  const attributes = links.filter((l): l is Record<string, unknown> => !!l && typeof l === "object");
  const link = attributes.find(l => l["@_rel"] === "alternate") ?? attributes[0];
  const url = atom ? text(link?.["@_href"]) || text(o.id) : text(o.link) || text(o.guid);
  const title = text(o.title).replace(/\s+/g, " ").trim();
  const body = atom ? text(o.content ?? o.summary) : text(o["content:encoded"] ?? o.description);
  const date = text(atom ? o.published || o.updated : o.pubDate);
  if (!url || !title || !body) throw new Error("unknown/incomplete source entry");
  return { url: normalizeUrl(url), title, body, published_at: parsePublishedAt(date) };
}

export function compareCandidate(value: unknown, row: Row) {
  const entry = sourceEntry(value);
  const snapshotDate = parsePublishedAt(row.published_at);
  const dateKnown = entry.published_at !== null && snapshotDate !== null;
  const identity = dateKnown && entry.url === normalizeUrl(row.url) && entry.title === row.title.replace(/\s+/g, " ").trim() && entry.published_at === snapshotDate;
  const body = normalizeBody(entry.body).slice(0, row.body_kind === "transcript" ? MAX_TRANSCRIPT_CHARS : MAX_BODY_CHARS);
  return { identity, date_known: dateKnown, body_reproduced: body === row.body, db_body_hash_valid: contentHash(row.body) === row.content_hash,
    // Diagnostic only: this is not proof that the historical ingest used this order.
    pre_strip_cap_reproduced: normalizeBody(entry.body.slice(0, MAX_BODY_CHARS)) === row.body,
    historical_byte_identity: "unproven" as const, archived_body_chars: normalizeBody(entry.body).length, snapshot_body_chars: row.body.length };
}

export function audit(args: string[]) {
  if (args.length !== 7) throw new Error("usage: <candidate-root> <candidate-manifest> <manifest-sha256> <snapshot-db> <backup-manifest> <pilot|all> <new-private-output>");
  const [root, manifestPath, expectedHash, dbPath, backupPath, scope, output] = args;
  if (scope !== "pilot" && scope !== "all") throw new Error("invalid scope");
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expectedHash) throw new Error("manifest hash mismatch");
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  const backupBytes = readFileSync(backupPath);
  if (sha256(backupBytes) !== manifest.source_backup_manifest_sha256) throw new Error("backup manifest linkage mismatch");
  const backup = JSON.parse(backupBytes.toString()) as Manifest;
  const dbEntry = backup.files.find(f => f.path === "insight.db");
  const dbBytes = readFileSync(dbPath);
  if (!dbEntry || dbEntry.size !== dbBytes.length || dbEntry.sha256 !== sha256(dbBytes)) throw new Error("snapshot hash mismatch");
  assertStandaloneSnapshot(dbPath, dbBytes);
  const seen = new Set<string>();
  const files = manifest.files.map(f => {
    if (seen.has(f.path)) throw new Error("duplicate manifest path");
    if (!((f.kind === "raw" && /^\.data\/raw\/ci_[A-Za-z0-9_-]+\.txt$/.test(f.path))
      || (f.kind === "report" && /^\.data\/reports\/rep_[A-Za-z0-9_-]+\.(md|html)$/.test(f.path)))) throw new Error("invalid candidate kind/path");
    seen.add(f.path);
    return { entry: f, bytes: verifiedFile(root, f) };
  });
  const actual = candidatePaths(root);
  if (actual.length !== seen.size || actual.some(path => !seen.has(path))) throw new Error("unlisted candidate files");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("snapshot quick_check failed");
    const pilotIds = new Set((db.prepare(`SELECT DISTINCT ci.id FROM report r JOIN json_each(r.insight_ids) j
      JOIN insight i ON i.id=j.value JOIN citation c ON c.insight_id=i.id
      JOIN citation_check cc ON cc.batch_id=i.batch_id AND cc.insight_id=i.id AND cc.citation_index=c.citation_index
      JOIN content_item ci ON ci.id=c.content_item_id WHERE r.status='done' AND cc.verdict='pass'
      AND cc.reachability='pass' AND cc.consistency='support' AND ci.raw_ref LIKE '.data/raw/%'`).all() as {id:string}[]).map(r => r.id));
    const raw = files.filter(f => f.entry.kind === "raw").filter(f => scope === "all" || pilotIds.has(basename(f.entry.path, ".txt"))).map(f => {
      const id = basename(f.entry.path, ".txt");
      const row = db.prepare("SELECT * FROM content_item WHERE id=?").get(id) as Row | undefined;
      if (!row) return { id, error: "missing_snapshot_row" };
      try { return { id, ...compareCandidate(JSON.parse(f.bytes.toString()), row) }; }
      catch { return { id, error: "unrecognized_archive" }; }
    });
    const reports = files.filter(f => f.entry.kind === "report").map(f => {
      const id = basename(f.entry.path).replace(/\.(md|html)$/, "");
      const row = db.prepare("SELECT * FROM report WHERE id=?").get(id) as { title:string; insight_ids:string; citation_count:number } | undefined;
      if (!row) return { id, error: "missing_snapshot_row" };
      const quotes = db.prepare(`SELECT c.quote FROM json_each(?) j JOIN insight i ON i.id=j.value
        JOIN citation c ON c.insight_id=i.id JOIN citation_check cc ON cc.batch_id=i.batch_id
        AND cc.insight_id=i.id AND cc.citation_index=c.citation_index WHERE cc.verdict='pass'
        AND cc.reachability='pass' AND cc.consistency='support'`).all(row.insight_ids) as {quote:string}[];
      const body = normalizeBody(f.bytes.toString());
      const flagged = db.prepare(`SELECT count(*) n FROM json_each(?) j JOIN insight i ON i.id=j.value
        JOIN citation_check cc ON cc.batch_id=i.batch_id AND cc.insight_id=i.id
        WHERE cc.verdict='flagged' AND cc.consistency='uncertain'`).get(row.insight_ids) as {n:number};
      return { id, format: basename(f.entry.path).split(".").pop(), title_present: body.includes(normalizeBody(row.title)),
        stored_citation_count: row.citation_count, snapshot_pass_citations: quotes.length,
        snapshot_flagged_uncertain: flagged.n,
        literal_quotes_present: quotes.filter(q => f.bytes.toString().includes(q.quote)).length,
        normalized_quotes_present: quotes.filter(q => body.includes(normalizeBody(q.quote))).length,
        historical_byte_identity: "unproven" };
    });
    const summary = { scope, verified_files: files.length, raw_examined: raw.length,
      identity_matches: raw.filter(r => "identity" in r && r.identity).length,
      body_reproduced: raw.filter(r => "body_reproduced" in r && r.body_reproduced).length,
      alternate_order_only: raw.filter(r => "body_reproduced" in r && !r.body_reproduced && r.pre_strip_cap_reproduced).length,
      db_hash_matches: raw.filter(r => "db_body_hash_valid" in r && r.db_body_hash_valid).length,
      report_files_examined: reports.length, historical_bytes_authenticated: 0, restore_approved: false };
    writeFileSync(output, JSON.stringify({ schema: 1, tool: "c1-candidate-audit", manifest_sha256: expectedHash,
      backup_manifest_sha256: sha256(backupBytes), snapshot_sha256: sha256(dbBytes), summary, raw, reports }, null, 2), { flag: "wx", mode: 0o600 });
    return summary;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(audit(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "audit failed"); process.exitCode = 1; }
}
