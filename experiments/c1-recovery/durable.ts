/** Same-host, synthetic-only SQLite authority. Not an AWS adapter or production trust root. */
import Database from "better-sqlite3";
import { randomUUID, type KeyObject } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import type { DB } from "../../src/lib/db/index.js";
import { C1_SYNTHETIC_REGISTRY_SCHEMA_SQL } from "../../src/lib/db/schema.js";
import { authenticated, digest, signed, utc, type Backup, type Checkpoint, type Entry, type FrozenAuthority, type ObjectVersion, type Signed } from "./core.js";
import { privateSyntheticPath } from "./private-store.js";
import { publicKeyDigest, type SyntheticFreshnessAnchor } from "./freshness.js";

type State = { protocol: "synthetic-registry-v1"; epoch: string; origin: string; sequence: number; head: string;
  pending: string[]; checkpoint: Signed<Checkpoint> | null; anchorId?: string | null };
type LogObject = { epoch: string; sequence: number; previous: string; object: ObjectVersion };
function fail(code: string): never { throw new Error(`synthetic_registry_${code}`); }
const encode = (v: unknown) => JSON.stringify(v);

export class DurableSyntheticAuthority implements FrozenAuthority {
  readonly epoch: string;
  #db: DB;
  #signer: KeyObject;
  #trust: KeyObject;
  #anchor: SyntheticFreshnessAnchor | undefined;
  private constructor(db: DB, epoch: string, signer: KeyObject, trust: KeyObject) {
    this.#db = db; this.epoch = epoch; this.#signer = signer; this.#trust = trust;
    authenticated(signed({ probe: "synthetic-registry-key-pair" }, signer), trust);
  }
  static create(path: string, origin: string, signer: KeyObject, trust: KeyObject): DurableSyntheticAuthority {
    return this.initialize(path, origin, signer, trust);
  }
  private static initialize(path: string, origin: string, signer: KeyObject, trust: KeyObject, anchor?: SyntheticFreshnessAnchor): DurableSyntheticAuthority {
    utc(origin); privateSyntheticPath(path, false);
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
          anchorId: anchor?.id ?? null,
        } satisfies State, signer)));
      }).immediate();
      if (anchor) {
        if (realpathSync(path) === realpathSync(anchor.path)) fail("anchor_not_independent");
        anchor.enroll(epoch, publicKeyDigest(trust), authority.stateHash());
        authority.#anchor = anchor;
      }
      return authority;
    } catch (error) { db.close(); throw error; }
  }
  static open(path: string, expectedEpoch: string, signer: KeyObject, trust: KeyObject): DurableSyntheticAuthority {
    return this.connect(path, expectedEpoch, signer, trust);
  }
  private static connect(path: string, expectedEpoch: string, signer: KeyObject, trust: KeyObject, anchor?: SyntheticFreshnessAnchor): DurableSyntheticAuthority {
    privateSyntheticPath(path, true);
    const db = new Database(path, { fileMustExist: true });
    try {
      const authority = new DurableSyntheticAuthority(db, expectedEpoch, signer, trust);
      if (anchor && realpathSync(path) === realpathSync(anchor.path)) fail("anchor_not_independent");
      authority.#anchor = anchor;
      authority.configure(); authority.checked(() => undefined); return authority;
    } catch (error) { db.close(); throw error; }
  }
  static createAnchored(path: string, origin: string, signer: KeyObject, trust: KeyObject, anchor: SyntheticFreshnessAnchor): DurableSyntheticAuthority {
    if (!anchor) fail("anchor_required");
    return this.initialize(path, origin, signer, trust, anchor);
  }
  static openAnchored(path: string, epoch: string, signer: KeyObject, trust: KeyObject, anchor: SyntheticFreshnessAnchor): DurableSyntheticAuthority {
    if (!anchor) fail("anchor_required");
    return this.connect(path, epoch, signer, trust, anchor);
  }
  private stateHash(): string {
    const row = this.#db.prepare("SELECT signed_state FROM c1_registry_state WHERE id=1").get() as { signed_state: string };
    return digest(row.signed_state);
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
    // Old APIs remain only for unanchored fixtures; they cannot downgrade an enrolled registry.
    if ((state.anchorId ?? null) !== (this.#anchor?.id ?? null)) fail("anchor_required");
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const view = this.read(), before = this.stateHash(), issuer = publicKeyDigest(this.#trust);
      this.#anchor?.assertCurrent(this.epoch, issuer, before);
      const value = fn(view), after = this.stateHash();
      if (this.#anchor && before !== after) {
        const reservation = this.#anchor.reserve(this.epoch, issuer, before, after);
        // Reserve is already durable. Finalize holds the anchor lock across registry COMMIT;
        // any failure leaves pending, never returns a successful token/checkpoint/backup.
        this.#anchor.finalize(reservation, () => this.#db.exec("COMMIT"));
      } else this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.#db.inTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
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
