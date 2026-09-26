/** Offline, deterministic materialization of verified shadow evidence; no DB writes or requests. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { getSource, transcriptAcquisitionEventKey } from "../src/lib/db/repos.js";
import { canonicalHash } from "../src/lib/db/provenance-facts.js";
import { extractCiteTranscript, extractHtmlTranscript, rawToContentItem, stripTranscript } from "../src/lib/sources/normalize.js";
import { stableEvidenceUrl } from "../src/lib/sources/podcast-evidence.js";
import type { ContentItem, TranscriptAcquisitionFact } from "../src/lib/types.js";

const VERSION = "podcast-shadow-eval-input-v1";
const ADAPTER = "rss-podcast-transcript-shadow-v1";
const FACT_ADAPTER = `${ADAPTER}+podcast-screen-v1`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const utc = z.string().refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const id = z.string().regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({
  version: z.literal("podcast-shadow-eval-request-v1"),
  shadow_root: z.string(),
  topic: z.object({ id, name: z.string().min(1), keywords: z.array(z.string()), language: z.enum(["zh", "en", "mixed"]) }).strict(),
  time_window: z.object({ start: utc, end: utc }).strict(),
  per_source: z.number().int().positive(),
  sources: z.array(z.object({ source_id: id, policy_version: z.string().trim().min(1), strategy: z.enum(["all", "relevant_only"]), adapter_version: z.literal(FACT_ADAPTER) }).strict()).min(1),
}).strict();
const payloadSchema = z.object({ stable_url: z.string(), content_type: z.string().nullable(), source_payload_sha256: digest,
  archived_payload_sha256: digest, raw_payload: z.string() });
const envelopeSchema = z.object({
  schema_version: z.literal("podcast-transcript-evidence-v2"), adapter_version: z.literal(ADAPTER), fetched_at: utc,
  episode: z.object({ url: z.string(), title: z.string(), published_at: z.string().nullable(), rss_item_source_sha256: digest,
    rss_item_archived_sha256: digest, rss_item: z.string() }).strict(),
  program_page: payloadSchema.strict(),
  transcript: payloadSchema.extend({ bytes: z.number().nonnegative(), duration_ms: z.number().nonnegative(), cleaned_body_sha256: digest }).strict(),
}).strict();

type Fact = TranscriptAcquisitionFact & { semantic_payload_hash: string };
export class ShadowInputError extends Error {}
function requireThat(ok: unknown, code: string): asserts ok { if (!ok) throw new ShadowInputError(code); }
function child(path: string, parent: string) {
  const rel = relative(parent, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function existing(path: string, kind: "file" | "directory") {
  requireThat(isAbsolute(path) && resolve(path) === path, "absolute_path_required");
  requireThat(realpathSync(path) === path && !lstatSync(path).isSymbolicLink(), "symlink_not_allowed");
  requireThat(kind === "file" ? lstatSync(path).isFile() : lstatSync(path).isDirectory(), "input_type_invalid");
}
/** Request files follow the same regular-file / no-symlink contract as snapshot inputs. */
export function readShadowInputRequest(path: string): unknown {
  const absolute = resolve(path);
  existing(absolute, "file");
  requireThat(lstatSync(absolute).size <= 1024 * 1024, "request_size_limit");
  return JSON.parse(readFileSync(absolute, "utf8"));
}
function stableUrl(value: string) {
  const u = new URL(value);
  requireThat(["https:", "http:"].includes(u.protocol) && stableEvidenceUrl(value) === value, "evidence_url_invalid");
  return value;
}
function checkFact(row: Fact) {
  requireThat(digest.safeParse(row.candidate_hash).success, "candidate_hash_invalid");
  requireThat(row.event_key === transcriptAcquisitionEventKey(row), "fact_event_key_mismatch");
  const { semantic_payload_hash, occurred_at, run_id, ...semantic } = row;
  void run_id;
  requireThat(canonicalHash(semantic) === semantic_payload_hash, "fact_payload_hash_mismatch");
  requireThat(utc.safeParse(occurred_at).success, "fact_time_invalid");
  requireThat(row.content_item_id === null && row.mode === "observe" && row.execution_scope === "shadow", "fact_scope_invalid");
  stableUrl(row.canonical_episode_url);
}

function evidence(root: string, fact: Fact) {
  requireThat(fact.raw_ref && /^archive\/[a-f0-9]{64}\.json$/.test(fact.raw_ref), "archive_ref_invalid");
  const path = join(root, fact.raw_ref);
  existing(path, "file");
  requireThat(lstatSync(path).size <= 64 * 1024 * 1024, "archive_size_limit");
  const bytes = readFileSync(path);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const checked = envelopeSchema.safeParse(parsed);
  requireThat(checked.success, "envelope_schema_invalid");
  const e = checked.data;
  const identity = { ...(parsed as Record<string, unknown>) };
  delete identity.fetched_at;
  requireThat(fact.raw_ref === `archive/${sha(`${fact.source_id}\n${JSON.stringify(identity)}`)}.json`, "archive_identity_mismatch");
  requireThat(stableUrl(e.episode.url) === fact.canonical_episode_url && stableUrl(e.program_page.stable_url) === e.episode.url, "episode_binding_mismatch");
  stableUrl(e.transcript.stable_url);
  requireThat(sha(e.episode.rss_item) === e.episode.rss_item_archived_sha256 && sha(e.program_page.raw_payload) === e.program_page.archived_payload_sha256 && sha(e.transcript.raw_payload) === e.transcript.archived_payload_sha256, "archive_payload_hash_mismatch");
  const mime = e.transcript.content_type?.split(";", 1)[0].trim().toLowerCase();
  requireThat(mime && ["text/plain", "text/vtt", "text/srt", "application/x-subrip", "text/html"].includes(mime), "transcript_mime_unsupported");
  const raw = e.transcript.raw_payload;
  // Same dispatch and pure cleaners as fetchTranscript; pinned to the v1 adapter contract.
  const html = /class="[^"]*\bts-text\b/i.test(raw);
  const cite = /<cite\b[^>]*>/i.test(raw) && /<\/p>/i.test(raw);
  requireThat(mime !== "text/html" || html || cite, "transcript_html_unsupported");
  const body = html ? extractHtmlTranscript(raw) : cite ? extractCiteTranscript(raw) : stripTranscript(raw);
  requireThat(body && sha(body) === e.transcript.cleaned_body_sha256, "cleaned_body_hash_mismatch");
  return { e, body, bytes, archiveHash: sha(bytes) };
}

export function materializeShadowInput(input: unknown, output: string, isolatedRoot: string) {
  const checked = requestSchema.safeParse(input);
  requireThat(checked.success, "request_invalid");
  const request = checked.data;
  requireThat(request.time_window.start < request.time_window.end, "time_window_invalid");
  requireThat(new Set(request.sources.map((s) => s.source_id)).size === request.sources.length, "duplicate_source");
  existing(isolatedRoot, "directory");
  const defaultData = join(repoRoot, ".data");
  requireThat(!isolatedRoot.split(sep).includes(".data") && isolatedRoot !== defaultData && !child(isolatedRoot, defaultData), "isolated_root_required");
  const root = request.shadow_root;
  existing(root, "directory");
  requireThat(child(root, isolatedRoot) && isAbsolute(output) && resolve(output) === output && child(output, isolatedRoot)
    && output !== root && !child(output, root) && !child(root, output), "isolated_paths_required");
  existing(dirname(output), "directory");
  requireThat(!existsSync(output), "output_exists");
  const dbPath = join(root, "shadow.db");
  existing(dbPath, "file");
  requireThat(!["-wal", "-shm", "-journal"].some((suffix) => existsSync(dbPath + suffix)), "closed_snapshot_required");
  // SQLite readonly is insufficient for a WAL header: SELECT can create WAL/SHM sidecars.
  // Validate the closed rollback-journal snapshot before SQLite opens it. Never change pragmas here.
  const dbBytes = readFileSync(dbPath);
  requireThat(dbBytes.length >= 100 && dbBytes.subarray(0, 16).toString("ascii") === "SQLite format 3\0", "snapshot_format_invalid");
  requireThat(dbBytes[18] === 1 && dbBytes[19] === 1, "delete_journal_snapshot_required");
  const dbHash = sha(dbBytes);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const selected: Array<{ item: ContentItem; fact: Fact; bytes: Buffer; archiveHash: string; bodyHash: string }> = [];
  const counts: Array<{ source_id: string; policy_version: string; adapter_version: string; strategy: string; eligible: number; attempted: number; succeeded: number; selected: number }> = [];
  const seenUrls = new Set<string>();
  try {
    db.transaction(() => {
      for (const pin of request.sources) {
        const source = getSource(db, pin.source_id);
        requireThat(source && source.topic_ids.includes(request.topic.id), "source_topic_mismatch");
        const rows = db.prepare(`SELECT * FROM transcript_acquisition_fact WHERE source_id=? AND transcript_policy_version=? AND strategy=? AND adapter_version=? AND mode='observe' AND execution_scope='shadow' ORDER BY canonical_episode_url,candidate_hash,attempt,stage`).all(pin.source_id, pin.policy_version, pin.strategy, pin.adapter_version) as Fact[];
        const groups = new Map<string, Fact[]>();
        for (const row of rows) {
          checkFact(row);
          requireThat(!db.prepare("SELECT 1 FROM transcript_acquisition_conflict WHERE event_key=? LIMIT 1").get(row.event_key), "fact_conflict");
          const groupKey = `${row.canonical_episode_url}\n${row.candidate_hash}`;
          const group = groups.get(groupKey) ?? [];
          group.push(row); groups.set(groupKey, group);
        }
        const stat = { ...pin, eligible: 0, attempted: 0, succeeded: 0, selected: 0 };
        const sourceItems: typeof selected = [];
        const candidateUrls = new Set<string>();
        for (const rows of groups.values()) {
          const candidate = rows.find((r) => r.stage === "candidate");
          requireThat(candidate, "candidate_missing");
          if (candidate.occurred_at < request.time_window.start || candidate.occurred_at > request.time_window.end) continue;
          requireThat(!candidateUrls.has(candidate.canonical_episode_url), "ambiguous_episode_candidate");
          candidateUrls.add(candidate.canonical_episode_url);
          stat.eligible++;
          const decision = rows.find((r) => r.stage === "decision");
          requireThat(decision && ["fetch", "unknown", "hard_negative"].includes(decision.decision ?? "")
            && decision.decision === candidate.decision, "decision_binding_mismatch");
          if (rows.some((r) => r.stage === "attempt")) stat.attempted++;
          const attempt = Math.max(...rows.map((r) => r.attempt));
          const terminal = rows.find((r) => r.stage === "terminal" && r.attempt === attempt);
          if (!terminal || terminal.outcome !== "success") continue;
          requireThat(terminal.evidence_status === "verified" && terminal.decision === decision.decision
            && rows.some((r) => r.stage === "attempt" && r.attempt === attempt && r.decision === terminal.decision)
            && (pin.strategy === "all" || terminal.decision !== "hard_negative"), "success_chain_invalid");
          requireThat(terminal.occurred_at <= request.time_window.end && terminal.occurred_at >= candidate.occurred_at, "terminal_time_invalid");
          stat.succeeded++;
          const archive = evidence(root, terminal);
          const item = rawToContentItem({ url: archive.e.episode.url, title: archive.e.episode.title, author: null,
            published_at: archive.e.episode.published_at, body: archive.body, body_kind: "transcript", raw: archive.e.episode.rss_item }, source, archive.e.fetched_at);
          requireThat(item.fetch_status === "ok" && item.body.trim(), "incomplete_transcript");
          item.speaker_map_status = "unknown"; item.speaker_map_ref = null;
          item.topic_ids = [request.topic.id];
          item.raw_ref = join(output, "evidence", `${archive.archiveHash}.json`);
          requireThat(!seenUrls.has(item.url), "duplicate_episode");
          seenUrls.add(item.url);
          sourceItems.push({ item, fact: terminal, bytes: archive.bytes, archiveHash: archive.archiveHash, bodyHash: archive.e.transcript.cleaned_body_sha256 });
        }
        requireThat(sourceItems.length >= request.per_source, "insufficient_source_transcripts");
        sourceItems.sort((a, b) => a.item.url < b.item.url ? -1 : a.item.url > b.item.url ? 1 : 0);
        selected.push(...sourceItems.slice(0, request.per_source));
        stat.selected = request.per_source; counts.push(stat);
      }
    })();
  } finally { db.close(); }
  requireThat(sha(readFileSync(dbPath)) === dbHash, "snapshot_changed");
  const quality = `${JSON.stringify({ topic: { ...request.topic, brief_schedule: "daily", enabled: true }, time_window: request.time_window, stratum: "transcript", items: selected.map((s) => s.item) })}\n`;
  const toolFiles = ["evals/podcast-shadow-eval-input.ts", "src/lib/sources/normalize.ts", "src/lib/db/repos.ts", "src/lib/db/provenance-facts.ts"];
  const manifest = {
    version: VERSION, scope: "offline_input_only", sampler_commit: null, sampler_commit_status: "not_recorded_by_shadow_schema",
    tool_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    tool_files_sha256: Object.fromEntries(toolFiles.map((file) => [file, sha(readFileSync(join(repoRoot, file)))])),
    request_sha256: canonicalHash(request), input_db_sha256: dbHash, time_window: request.time_window,
    topic_id: request.topic.id, per_source: request.per_source, sources: counts, quality_sha256: sha(quality),
    selected: selected.map(({ item, fact, archiveHash, bodyHash }) => ({ content_id: item.id, source_id: item.source_id,
      event_key: fact.event_key, candidate_hash: fact.candidate_hash, semantic_payload_hash: fact.semantic_payload_hash,
      body_kind: item.body_kind, cleaned_body_sha256: bodyHash, content_hash: item.content_hash, archive_sha256: archiveHash })),
  };
  // Exclusive directory claim: never overwrite existing artifacts. A manifest is written last.
  mkdirSync(output, { mode: 0o700 });
  try {
    mkdirSync(join(output, "evidence"), { mode: 0o700 });
    for (const s of selected) writeFileSync(s.item.raw_ref, s.bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(join(output, "quality.jsonl"), quality, { flag: "wx", mode: 0o600 });
    writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  return manifest;
}
