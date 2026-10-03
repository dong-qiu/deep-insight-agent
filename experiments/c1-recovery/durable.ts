/** Same-host, synthetic-only SQLite authority. Not an AWS adapter or production trust root. */
import Database from "better-sqlite3";
import { randomUUID, type KeyObject } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { DB } from "../../src/lib/db/index.js";
import { C1_SYNTHETIC_REGISTRY_SCHEMA_SQL } from "../../src/lib/db/schema.js";
import { authenticated, digest, signed, utc, type Backup, type Checkpoint, type Entry, type FrozenAuthority, type ObjectVersion, type Signed } from "./core.js";

type State = { protocol: "synthetic-registry-v1"; epoch: string; origin: string; sequence: number; head: string;
  pending: string[]; checkpoint: Signed<Checkpoint> | null };
type LogObject = { epoch: string; sequence: number; previous: string; object: ObjectVersion };
function fail(code: string): never { throw new Error(`synthetic_registry_${code}`); }
const encode = (v: unknown) => JSON.stringify(v);

function privatePath(path: string, existing: boolean) {
  if (!isAbsolute(path)) fail("path_invalid");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) fail("directory_not_private");
  if (existing) {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0) fail("file_not_private");
  }
}

export class DurableSyntheticAuthority implements FrozenAuthority {
  readonly epoch: string;
  #db: DB;
  #signer: KeyObject;
  #trust: KeyObject;
  private constructor(db: DB, epoch: string, signer: KeyObject, trust: KeyObject) {
    this.#db = db; this.epoch = epoch; this.#signer = signer; this.#trust = trust;
    authenticated(signed({ probe: "synthetic-registry-key-pair" }, signer), trust);
  }
  static create(path: string, origin: string, signer: KeyObject, trust: KeyObject): DurableSyntheticAuthority {
    utc(origin); privatePath(path, false);
    authenticated(signed({ probe: "synthetic-registry-key-pair" }, signer), trust);
    // Exclusive creation: never replace/reinitialize an existing registry, even an empty file.
    closeSync(openSync(path, "wx", 0o600));
    const db = new Database(path), epoch = randomUUID();
    try {
      const authority = new DurableSyntheticAuthority(db, epoch, signer, trust);
      authority.configure();
      db.transaction(() => {
        db.exec(C1_SYNTHETIC_REGISTRY_SCHEMA_SQL);
        db.prepare("INSERT INTO c1_registry_state VALUES (1,?)").run(encode(signed({
          protocol: "synthetic-registry-v1", epoch, origin, sequence: 0, head: "genesis", pending: [], checkpoint: null,
        } satisfies State, signer)));
      }).immediate();
      return authority;
    } catch (error) { db.close(); throw error; }
  }
  static open(path: string, expectedEpoch: string, signer: KeyObject, trust: KeyObject): DurableSyntheticAuthority {
    privatePath(path, true);
    const db = new Database(path, { fileMustExist: true });
    try {
      const authority = new DurableSyntheticAuthority(db, expectedEpoch, signer, trust);
      authority.configure(); authority.checked(() => undefined); return authority;
    } catch (error) { db.close(); throw error; }
  }
  private configure() {
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
  }
  private read(): { state: State; objects: ObjectVersion[]; entries: Entry[] } {
    const row = this.#db.prepare("SELECT signed_state FROM c1_registry_state WHERE id=1").get() as { signed_state: string } | undefined;
    if (!row) fail("state_missing");
    const state = authenticated(JSON.parse(row.signed_state) as Signed<State>, this.#trust);
    if (state.protocol !== "synthetic-registry-v1" || state.epoch !== this.epoch || !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0 || !Array.isArray(state.pending) || new Set(state.pending).size !== state.pending.length ||
      state.pending.some((token) => typeof token !== "string" || !token)) fail("state_invalid");
    utc(state.origin);
    const rows = this.#db.prepare("SELECT sequence,object_key,signed_object FROM c1_registry_object ORDER BY sequence").all() as
      { sequence: number; object_key: string; signed_object: string }[];
    if (rows.length !== state.sequence) fail("log_incomplete");
    let head = "genesis";
    const objects: ObjectVersion[] = [], entries: Entry[] = [];
    for (const [index, row] of rows.entries()) {
      const envelope = JSON.parse(row.signed_object) as Signed<LogObject>;
      const item = authenticated(envelope, this.#trust), object = item.object;
      if (row.sequence !== index + 1 || item.sequence !== row.sequence || item.epoch !== state.epoch || item.previous !== head ||
        !object || typeof object.key !== "string" || !object.key || object.key !== row.object_key ||
        typeof object.version !== "string" || !object.version || typeof object.body !== "string") fail("log_invalid");
      head = digest(encode(envelope)); objects.push(object);
      entries.push({ sequence: item.sequence, key: object.key, version: object.version, hash: digest(object.body) });
    }
    if (head !== state.head) fail("head_invalid");
    if (state.checkpoint !== null) {
      const checkpoint = authenticated(state.checkpoint, this.#trust);
      if (state.pending.length || checkpoint.protocol !== "synthetic-c1-v1" || checkpoint.epoch !== state.epoch ||
        checkpoint.origin !== state.origin || checkpoint.baseline !== "empty-at-origin" ||
        utc(checkpoint.cutoff) < utc(state.origin) || encode(checkpoint.entries) !== encode(entries)) fail("gate_invalid");
    }
    return { state, objects, entries };
  }
  private checked<T>(fn: (view: ReturnType<DurableSyntheticAuthority["read"]>) => T): T {
    // BEGIN IMMEDIATE serializes verification, sequence allocation, gate checks and commit acknowledgement.
    return this.#db.transaction(() => fn(this.read())).immediate();
  }
  private save(state: State) {
    this.#db.prepare("UPDATE c1_registry_state SET signed_state=? WHERE id=1").run(encode(signed(state, this.#signer)));
  }
  begin(): string {
    return this.checked(({ state }) => {
      if (state.checkpoint) fail("maintenance_closed");
      const token = randomUUID(); state.pending.push(token); this.save(state); return token;
    });
  }
  commit(token: string, object: ObjectVersion): void {
    this.checked(({ state, objects }) => {
      if (state.checkpoint || !state.pending.includes(token)) fail("commit_fenced");
      if (!object || typeof object.key !== "string" || !object.key || typeof object.version !== "string" || !object.version ||
        typeof object.body !== "string" || objects.some((item) => item.key === object.key)) fail("object_conflict");
      const envelope = signed({ epoch: state.epoch, sequence: state.sequence + 1, previous: state.head, object }, this.#signer);
      this.#db.prepare("INSERT INTO c1_registry_object VALUES (?,?,?)").run(envelope.payload.sequence, object.key, encode(envelope));
      state.sequence++; state.head = digest(encode(envelope)); state.pending = state.pending.filter((item) => item !== token);
      this.save(state);
    });
  }
  /** Only the caller can resolve an uncommitted intent; restart never automatically discards pending. */
  abort(token: string): void {
    this.checked(({ state }) => {
      if (state.checkpoint || !state.pending.includes(token)) fail("pending_unknown");
      state.pending = state.pending.filter((item) => item !== token); this.save(state);
    });
  }
  backup(db: DB, sampledAt: string): Signed<Backup> {
    if (db.name !== ":memory:") fail("memory_only");
    return this.checked(({ state }) => {
      if (state.checkpoint || state.pending.length || utc(sampledAt) < utc(state.origin)) fail("sample_invalid");
      return signed({ protocol: "synthetic-c1-v1", epoch: state.epoch, sampledAt, sequence: state.sequence, digest: digest(db.serialize()) }, this.#signer);
    });
  }
  freeze(cutoff: string): Signed<Checkpoint> {
    return this.checked(({ state, entries }) => {
      if (state.checkpoint || state.pending.length || utc(cutoff) < utc(state.origin)) fail("freeze_invalid");
      state.checkpoint = signed({ protocol: "synthetic-c1-v1", epoch: state.epoch, origin: state.origin, cutoff, baseline: "empty-at-origin", entries }, this.#signer);
      this.save(state); return structuredClone(state.checkpoint);
    });
  }
  objects(): ObjectVersion[] { return this.checked(({ objects }) => objects); }
  assertFrozen(checkpoint: Signed<Checkpoint>): void {
    this.checked(({ state }) => { if (!state.checkpoint || encode(checkpoint) !== encode(state.checkpoint)) fail("gate_invalid"); });
  }
  close(): void { this.#db.close(); }
}
