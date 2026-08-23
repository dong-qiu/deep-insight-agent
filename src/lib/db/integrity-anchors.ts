/**
 * P1c immutable manifest/anchor primitives.  This module deliberately has no
 * reader dependency: callers publish first and make their SQLite projection
 * visible only after `anchorCandidate` has succeeded.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export const SHA256 = "sha-256" as const;
export const MANIFEST_SCHEMA = "manifest-v1" as const;
export const ANCHOR_SCHEMA = "anchor-v1" as const;

export interface ExternalAnchorLocator { anchor_schema_version: "anchor-v1"; object_key: string }
export interface ArtifactManifest {
  tenant_id: string; report_id: string; artifact_id: string; artifact_version: string;
  length: number; media_type: string; created_at: string; upstream_trace_id: string;
  content_hash_algorithm: "sha-256"; content_hash: string;
  manifest_schema_version: "manifest-v1"; external_anchor: ExternalAnchorLocator;
}
export interface AnchorBinding {
  binding_schema_version: "binding-v1"; binding_kind: "manifest-v1-sha256";
  tenant_id: string; report_id: string; artifact_id: string; artifact_version: string;
  manifest_schema_version: "manifest-v1"; manifest_canonicalization: "rfc8785-jcs-utf8";
  manifest_hash_algorithm: "sha-256"; manifest_hash: string;
}
export interface AnchorPayload {
  anchor_schema_version: "anchor-v1"; object_key: string;
  content_hash_algorithm: "sha-256"; content_hash: string; issued_at: string; binding: AnchorBinding;
}
export interface SignedAnchor { payload: AnchorPayload; anchor_payload_hash: string; signature: string; key_id: string; algorithm: "ed25519" }
export interface AnchorSigner { key_id: string; private_key: KeyObject }
export interface AnchorObject { body: Uint8Array; provider_version_id: string | null }
export interface AnchorStore {
  /** Must be an If-None-Match:* equivalent.  Never overwrite an object. */
  putIfAbsent(key: string, body: Uint8Array, retainUntil: string): Promise<{ provider_version_id: string | null }>;
  get(key: string): Promise<AnchorObject | null>;
}
interface S3ObjectResponse { VersionId?: string; Body?: { transformToByteArray: () => Promise<Uint8Array> } }
type S3Sender = { send(command: unknown): Promise<S3ObjectResponse> };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^(?!\.\.?$)(?!.*(?:\/|\0|\\))[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(code: string): never { throw new Error(code); }
function exactKeys(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(code);
}
function stringField(value: unknown, name: string): asserts value is string { if (typeof value !== "string") fail(`${name}_invalid`); }
function scalarStrings(value: unknown): void {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i += 1) {
      const n = value.charCodeAt(i);
      if (n >= 0xd800 && n <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) fail("jcs_unpaired_surrogate");
        i += 1;
      } else if (n >= 0xdc00 && n <= 0xdfff) fail("jcs_unpaired_surrogate");
    }
  } else if (Array.isArray(value)) value.forEach(scalarStrings);
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(scalarStrings);
}

/** RFC 8785 compatible for JSON values represented by the JS runtime. */
export function jcs(value: unknown): string {
  scalarStrings(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("jcs_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${jcs((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  fail("jcs_unsupported_value");
}

export const utf8 = (value: unknown): Uint8Array => encoder.encode(jcs(value));
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const contentHash = (bytes: Uint8Array): string => sha256(bytes);

function assertId(value: string, name: string): void { if (!ID_RE.test(value)) fail(`${name}_invalid`); }
function assertHash(value: string, name: string): void { if (!HASH_RE.test(value)) fail(`${name}_invalid`); }
function assertInstant(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) fail(`${name}_invalid`);
}

/**
 * JSON.parse accepts duplicate members and arbitrary whitespace.  Anchor objects
 * cannot: their stored bytes are evidence, so a read is accepted only when the
 * raw UTF-8 document is the exact JCS serialization of a closed-schema value.
 */
function scanJson(source: string): void {
  let offset = 0;
  const ws = () => { while (/\s/.test(source[offset] ?? "")) offset += 1; };
  const string = (): string => {
    const start = offset; if (source[offset] !== '"') fail("anchor_json_invalid"); offset += 1;
    while (offset < source.length) {
      const c = source[offset++]!;
      if (c === '"') return JSON.parse(source.slice(start, offset)) as string;
      if (c === "\\") offset += 1;
      else if (c.charCodeAt(0) < 0x20) fail("anchor_json_invalid");
    }
    fail("anchor_json_invalid");
  };
  const value = (): void => {
    ws(); const c = source[offset];
    if (c === '"') { string(); return; }
    if (c === "{") {
      offset += 1; ws(); const seen = new Set<string>();
      if (source[offset] === "}") { offset += 1; return; }
      while (true) {
        ws(); const key = string(); if (seen.has(key)) fail("anchor_json_duplicate_key"); seen.add(key); ws();
        if (source[offset++] !== ":") fail("anchor_json_invalid"); value(); ws();
        if (source[offset] === "}") { offset += 1; return; }
        if (source[offset++] !== ",") fail("anchor_json_invalid");
      }
    }
    if (c === "[") {
      offset += 1; ws(); if (source[offset] === "]") { offset += 1; return; }
      while (true) { value(); ws(); if (source[offset] === "]") { offset += 1; return; } if (source[offset++] !== ",") fail("anchor_json_invalid"); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset));
    if (!match) fail("anchor_json_invalid"); offset += match[0].length;
  };
  value(); ws(); if (offset !== source.length) fail("anchor_json_invalid");
}
export function parseCanonicalJsonBytes(bytes: Uint8Array, code = "anchor_noncanonical_body"): unknown {
  let source: string;
  try { source = decoder.decode(bytes); scanJson(source); } catch (error) { if (error instanceof Error && error.message.startsWith("anchor_json_")) throw error; fail(code); }
  if (!source) fail(code);
  let value: unknown;
  try { value = JSON.parse(source); } catch { fail(code); }
  if (jcs(value) !== source) fail(code);
  return value;
}

export function anchorObjectKey(tenantId: string, reportId: string, artifactId: string, artifactVersion: string): string {
  assertId(tenantId, "tenant_id"); assertId(reportId, "report_id"); assertId(artifactId, "artifact_id"); assertId(artifactVersion, "artifact_version");
  return `integrity-anchors/v1/${tenantId}/${reportId}/${artifactId}/${artifactVersion}/anchor-v1.json`;
}

export function manifestForArtifact(input: Omit<ArtifactManifest, "content_hash_algorithm" | "content_hash" | "manifest_schema_version" | "external_anchor"> & { content: Uint8Array }): ArtifactManifest {
  assertId(input.tenant_id, "tenant_id"); assertId(input.report_id, "report_id"); assertId(input.artifact_id, "artifact_id"); assertId(input.artifact_version, "artifact_version");
  assertInstant(input.created_at, "created_at"); if (!Number.isSafeInteger(input.length) || input.length < 0 || input.length !== input.content.byteLength) fail("artifact_length_invalid");
  return { tenant_id: input.tenant_id, report_id: input.report_id, artifact_id: input.artifact_id, artifact_version: input.artifact_version,
    length: input.length, media_type: input.media_type, created_at: input.created_at, upstream_trace_id: input.upstream_trace_id,
    content_hash_algorithm: SHA256, content_hash: contentHash(input.content), manifest_schema_version: MANIFEST_SCHEMA,
    external_anchor: { anchor_schema_version: ANCHOR_SCHEMA, object_key: anchorObjectKey(input.tenant_id, input.report_id, input.artifact_id, input.artifact_version) } };
}

export function manifestCanonicalBytes(manifest: ArtifactManifest): Uint8Array {
  validateManifest(manifest); return utf8(manifest);
}
export function manifestHash(manifest: ArtifactManifest): string { return sha256(manifestCanonicalBytes(manifest)); }
export function anchorIdempotencyKey(manifest: ArtifactManifest): string {
  const h = manifestHash(manifest);
  return sha256(encoder.encode(`anchor-v1\0${manifest.tenant_id}\0${manifest.report_id}\0${manifest.artifact_id}\0${manifest.artifact_version}\0${h}`));
}
export function bindingFor(manifest: ArtifactManifest): AnchorBinding {
  return { binding_schema_version: "binding-v1", binding_kind: "manifest-v1-sha256", tenant_id: manifest.tenant_id, report_id: manifest.report_id,
    artifact_id: manifest.artifact_id, artifact_version: manifest.artifact_version, manifest_schema_version: MANIFEST_SCHEMA,
    manifest_canonicalization: "rfc8785-jcs-utf8", manifest_hash_algorithm: SHA256, manifest_hash: manifestHash(manifest) };
}
export function anchorPayload(manifest: ArtifactManifest, issuedAt: string): AnchorPayload {
  assertInstant(issuedAt, "issued_at");
  return { anchor_schema_version: ANCHOR_SCHEMA, object_key: manifest.external_anchor.object_key, content_hash_algorithm: SHA256,
    content_hash: manifest.content_hash, issued_at: issuedAt, binding: bindingFor(manifest) };
}
export function signAnchor(manifest: ArtifactManifest, issuedAt: string, signer: AnchorSigner): SignedAnchor {
  const payload = anchorPayload(manifest, issuedAt); const bytes = utf8(payload);
  return { payload, anchor_payload_hash: sha256(bytes), signature: sign(null, Buffer.concat([Buffer.from("anchor-v1\0"), Buffer.from(bytes)]), signer.private_key).toString("base64url"), key_id: signer.key_id, algorithm: "ed25519" };
}
export function anchorEnvelopeBytes(anchor: SignedAnchor): Uint8Array {
  validateSignedAnchor(anchor); return utf8({ payload: anchor.payload, anchor_payload_hash: anchor.anchor_payload_hash, signature: anchor.signature, key_id: anchor.key_id, algorithm: anchor.algorithm });
}
export function verifySignedAnchor(anchor: SignedAnchor, publicKey: KeyObject): boolean {
  try { validateSignedAnchor(anchor); return verify(null, Buffer.concat([Buffer.from("anchor-v1\0"), Buffer.from(utf8(anchor.payload))]), publicKey, Buffer.from(anchor.signature, "base64url")); } catch { return false; }
}
export function validateManifest(manifest: ArtifactManifest): void {
  exactKeys(manifest, ["tenant_id", "report_id", "artifact_id", "artifact_version", "length", "media_type", "created_at", "upstream_trace_id", "content_hash_algorithm", "content_hash", "manifest_schema_version", "external_anchor"], "manifest_schema_invalid");
  exactKeys(manifest.external_anchor, ["anchor_schema_version", "object_key"], "manifest_schema_invalid");
  stringField(manifest.media_type, "media_type"); stringField(manifest.upstream_trace_id, "upstream_trace_id");
  assertId(manifest.tenant_id, "tenant_id"); assertId(manifest.report_id, "report_id"); assertId(manifest.artifact_id, "artifact_id"); assertId(manifest.artifact_version, "artifact_version");
  if (manifest.manifest_schema_version !== MANIFEST_SCHEMA || manifest.content_hash_algorithm !== SHA256 || manifest.external_anchor.anchor_schema_version !== ANCHOR_SCHEMA) fail("manifest_schema_invalid");
  if (manifest.external_anchor.object_key !== anchorObjectKey(manifest.tenant_id, manifest.report_id, manifest.artifact_id, manifest.artifact_version)) fail("manifest_locator_mismatch");
  if (!Number.isSafeInteger(manifest.length) || manifest.length < 0) fail("manifest_length_invalid"); assertHash(manifest.content_hash, "content_hash"); assertInstant(manifest.created_at, "created_at");
}
export function validateSignedAnchor(anchor: SignedAnchor): void {
  exactKeys(anchor, ["payload", "anchor_payload_hash", "signature", "key_id", "algorithm"], "anchor_schema_invalid");
  exactKeys(anchor.payload, ["anchor_schema_version", "object_key", "content_hash_algorithm", "content_hash", "issued_at", "binding"], "anchor_schema_invalid");
  exactKeys(anchor.payload.binding, ["binding_schema_version", "binding_kind", "tenant_id", "report_id", "artifact_id", "artifact_version", "manifest_schema_version", "manifest_canonicalization", "manifest_hash_algorithm", "manifest_hash"], "anchor_schema_invalid");
  const payload = anchor.payload;
  stringField(anchor.anchor_payload_hash, "anchor_payload_hash"); stringField(anchor.signature, "anchor_signature"); stringField(anchor.key_id, "anchor_key_id");
  stringField(payload.object_key, "anchor_object_key"); stringField(payload.content_hash, "content_hash"); stringField(payload.issued_at, "issued_at");
  stringField(payload.binding.tenant_id, "tenant_id"); stringField(payload.binding.report_id, "report_id"); stringField(payload.binding.artifact_id, "artifact_id"); stringField(payload.binding.artifact_version, "artifact_version"); stringField(payload.binding.manifest_hash, "manifest_hash");
  if (anchor.algorithm !== "ed25519" || !anchor.key_id) fail("anchor_signature_invalid");
  assertHash(anchor.anchor_payload_hash, "anchor_payload_hash"); if (sha256(utf8(payload)) !== anchor.anchor_payload_hash) fail("anchor_payload_hash_mismatch");
  const b = payload.binding;
  if (payload.anchor_schema_version !== ANCHOR_SCHEMA || payload.content_hash_algorithm !== SHA256 || b.binding_schema_version !== "binding-v1" || b.binding_kind !== "manifest-v1-sha256" || b.manifest_canonicalization !== "rfc8785-jcs-utf8" || b.manifest_hash_algorithm !== SHA256) fail("anchor_schema_invalid");
  assertHash(payload.content_hash, "content_hash"); assertHash(b.manifest_hash, "manifest_hash"); assertInstant(payload.issued_at, "issued_at");
}
export function parseCanonicalAnchorEnvelope(bytes: Uint8Array, publicKey: KeyObject): SignedAnchor {
  const parsed = parseCanonicalJsonBytes(bytes) as SignedAnchor;
  validateSignedAnchor(parsed);
  const canonical = anchorEnvelopeBytes(parsed);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) fail("anchor_noncanonical_body");
  if (!verifySignedAnchor(parsed, publicKey)) fail("anchor_signature_invalid");
  return parsed;
}
export function anchorMatchesManifest(anchor: SignedAnchor, manifest: ArtifactManifest): boolean {
  try { validateSignedAnchor(anchor); validateManifest(manifest); const expected = anchorPayload(manifest, anchor.payload.issued_at); return jcs(anchor.payload) === jcs(expected); } catch { return false; }
}

/** Conditional write plus exact read-back verification for 412/unknown-result retries. */
export async function writeAnchor(store: AnchorStore, manifest: ArtifactManifest, issuedAt: string, retainUntil: string, signer: AnchorSigner): Promise<{ anchor: SignedAnchor; provider_version_id: string | null; reused: boolean }> {
  assertInstant(retainUntil, "retain_until"); const anchor = signAnchor(manifest, issuedAt, signer); const body = anchorEnvelopeBytes(anchor);
  try { const result = await store.putIfAbsent(manifest.external_anchor.object_key, body, retainUntil); return { anchor, provider_version_id: result.provider_version_id, reused: false }; }
  catch (error) {
    const existing = await store.get(manifest.external_anchor.object_key);
    if (!existing) throw error;
    let parsed: SignedAnchor;
    try { parsed = parseCanonicalAnchorEnvelope(existing.body, createPublicKey(signer.private_key)); } catch { fail("anchor_conflict"); }
    if (anchorEnvelopeBytes(parsed).some((byte, index) => byte !== body[index]) || !anchorMatchesManifest(parsed, manifest)) fail("anchor_conflict");
    return { anchor: parsed, provider_version_id: existing.provider_version_id, reused: true };
  }
}

/** Test/local adapter.  Production adapters must implement the same immutable contract. */
export class MemoryAnchorStore implements AnchorStore {
  private readonly objects = new Map<string, AnchorObject>();
  async putIfAbsent(key: string, body: Uint8Array): Promise<{ provider_version_id: string | null }> {
    if (this.objects.has(key)) throw new Error("precondition_failed");
    this.objects.set(key, { body: new Uint8Array(body), provider_version_id: null }); return { provider_version_id: null };
  }
  async get(key: string): Promise<AnchorObject | null> { return this.objects.get(key) ?? null; }
  replaceForTest(key: string, body: Uint8Array): void { this.objects.set(key, { body, provider_version_id: null }); }
}

/** S3-compatible immutable object adapter.  It never issues DeleteObject or a non-conditional PutObject. */
export class S3AnchorStore implements AnchorStore {
  constructor(private readonly client: S3Sender, private readonly bucket: string) { if (!bucket.trim()) fail("anchor_bucket_invalid"); }
  async putIfAbsent(key: string, body: Uint8Array, retainUntil: string): Promise<{ provider_version_id: string | null }> {
    const output = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "application/json", IfNoneMatch: "*", ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(retainUntil) }));
    return { provider_version_id: output.VersionId ?? null };
  }
  async get(key: string): Promise<AnchorObject | null> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!output.Body) fail("anchor_object_unreadable");
      return { body: await output.Body.transformToByteArray(), provider_version_id: output.VersionId ?? null };
    } catch (error) {
      const code = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (code.name === "NoSuchKey" || code.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
}

export function merkleRoot(manifestHashes: readonly string[]): string {
  if (!manifestHashes.length) return sha256(new Uint8Array());
  let level = manifestHashes.map((hash) => { assertHash(hash, "manifest_hash"); return hash; });
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(createHash("sha256").update(Buffer.concat([Buffer.from(level[i]!, "hex"), Buffer.from(level[i + 1] ?? level[i]!, "hex")])).digest("hex"));
    level = next;
  }
  return level[0]!;
}
