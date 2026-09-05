/** Deployment-owned P1c anchor configuration. Application code never falls
 * back to an in-memory store: a publication is either backed by this injected
 * immutable store or is rejected before it can become reader-visible. */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { S3AnchorStore, type AnchorSigner, type AnchorStore } from "../db/integrity-anchors.js";
import type { ReportAnchorPublication } from "../db/reports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type AnchorEnvironment = Readonly<Record<string, string | undefined>>;
type KmsSender = { send(command: unknown): Promise<{ PublicKey?: Uint8Array; SigningAlgorithms?: string[]; Signature?: Uint8Array }> };

/** AWS KMS keeps the Ed25519 private key non-exportable.  `GetPublicKey` is
 * used only to obtain SPKI verification material; signing sends exactly the
 * domain-separated bytes selected by the integrity primitives. */
export class KmsEd25519AnchorSigner implements AnchorSigner {
  private constructor(
    readonly key_id: string,
    readonly public_key: KeyObject,
    private readonly kms: KmsSender,
  ) {}

  static async create(keyId: string, kms: KmsSender = new KMSClient({})): Promise<KmsEd25519AnchorSigner> {
    if (!keyId.trim()) throw new Error("integrity_anchor_not_configured");
    try {
      const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (!response.PublicKey || !response.SigningAlgorithms?.includes("EDDSA")) throw new Error("invalid");
      const publicKey = createPublicKey({ key: Buffer.from(response.PublicKey), format: "der", type: "spki" });
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("invalid");
      return new KmsEd25519AnchorSigner(keyId, publicKey, kms);
    } catch {
      throw new Error("integrity_anchor_kms_verification_material_unavailable");
    }
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    try {
      const response = await this.kms.send(new SignCommand({
        KeyId: this.key_id, Message: message, MessageType: "RAW", SigningAlgorithm: "EDDSA" as never,
      }));
      if (!response.Signature?.byteLength) throw new Error("invalid");
      return new Uint8Array(response.Signature);
    } catch {
      // Preserve a stable, non-sensitive operational code. Do not expose KMS
      // request details, key ARN, message body, or signature material.
      throw new Error("integrity_anchor_kms_sign_failed");
    }
  }
}

/** P1c is deliberately opt-in. P0 publication keeps its citation/validator
 * contract when this is disabled; it must never manufacture anchor evidence.
 * Any non-boolean value fails closed rather than silently changing the
 * deployment's evidence posture. */
export function integrityAnchorEnabled(env: AnchorEnvironment = process.env): boolean {
  const raw = env.INTEGRITY_ANCHOR_ENABLED;
  if (raw == null) return false;
  // Deployment preflight applies the same grammar. Whitespace must never turn
  // an apparently disabled .env entry into an enabled runtime configuration.
  if (raw !== raw.trim()) throw new Error("integrity_anchor_enabled_invalid");
  const value = raw.toLowerCase();
  if (value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("integrity_anchor_enabled_invalid");
}

function required(env: AnchorEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error("integrity_anchor_not_configured");
  return value;
}

/** No P1 composition root is admitted until the dedicated INSI-25 production
 * admission implementation exists. Keeping this single guard at every
 * externally reachable P1 seam prevents an auxiliary admin route from
 * bypassing the report-publication gate. */
function requireIntegrityAnchorAdmission(env: AnchorEnvironment): never {
  void integrityAnchorEnabled(env);
  throw new Error("integrity_anchor_admission_required");
}

function optionalInstant(env: AnchorEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error("integrity_anchor_retain_until_invalid");
  return value;
}

function requiredFutureInstant(env: AnchorEnvironment, name: string, now: Date): string {
  const value = optionalInstant(env, name);
  if (!value || Date.parse(value) <= now.getTime()) throw new Error("integrity_anchor_retention_policy_required");
  return value;
}

/** Verification has only Object-Store read authority; it never loads signing material. */
export function deploymentAnchorVerificationStore(env: AnchorEnvironment = process.env): AnchorStore {
  requireIntegrityAnchorAdmission(env);
  return new S3AnchorStore(new S3Client({}), required(env, "INTEGRITY_ANCHOR_BUCKET"));
}

/** Legal holds need a deployment-owned horizon: callers cannot select or
 * shorten Object Lock Compliance retention. Missing policy is fail-closed. */
export function deploymentAnchorLegalHold(env: AnchorEnvironment = process.env, now = new Date()): { store: AnchorStore; retainUntil: string } {
  return {
    store: deploymentAnchorVerificationStore(env),
    retainUntil: requiredFutureInstant(env, "INTEGRITY_LEGAL_HOLD_RETAIN_UNTIL", now),
  };
}

/** Deployment-owned signer/store injection for the real dispatch path. */
export async function deploymentAnchorPublication(
  env: AnchorEnvironment = process.env,
  now = new Date(),
  dependencies: { kms?: KmsSender } = {},
): Promise<ReportAnchorPublication> {
  const bucket = required(env, "INTEGRITY_ANCHOR_BUCKET");
  const keyId = required(env, "INTEGRITY_ANCHOR_KEY_ID");
  const artifactDays = env.INTEGRITY_ANCHOR_RETAIN_DAYS == null ? 100 : Number(env.INTEGRITY_ANCHOR_RETAIN_DAYS);
  if (artifactDays != null && (!Number.isInteger(artifactDays) || artifactDays < 1 || artifactDays > 36500)) throw new Error("integrity_anchor_retain_days_invalid");
  const signerMode = env.INTEGRITY_ANCHOR_SIGNER ?? "pem";
  let signer: AnchorSigner;
  if (signerMode === "aws-kms") {
    // This explicit path intentionally does not consult a PEM environment
    // variable. KMS public material is recorded for local verification while
    // private signing material remains inside KMS.
    signer = await KmsEd25519AnchorSigner.create(keyId, dependencies.kms);
  } else if (signerMode === "pem") {
    const pem = required(env, "INTEGRITY_ANCHOR_PRIVATE_KEY_PEM").replace(/\\n/g, "\n");
    let privateKey: KeyObject;
    try { privateKey = createPrivateKey(pem); } catch { throw new Error("integrity_anchor_signer_invalid"); }
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("integrity_anchor_signer_invalid");
    signer = { key_id: keyId, private_key: privateKey };
  } else {
    throw new Error("integrity_anchor_signer_mode_invalid");
  }
  return {
    store: new S3AnchorStore(new S3Client({}), bucket),
    signer,
    // The report writer also adds `anchor issued_at + 100 days`; these are the
    // three policy horizons that must never be shortened by a deployment default.
    retainUntil: new Date(now.getTime() + artifactDays * DAY_MS).toISOString(),
    retentionEnds: [
      requiredFutureInstant(env, "INTEGRITY_REPORT_READABLE_UNTIL", now),
      requiredFutureInstant(env, "INTEGRITY_REPORT_ARCHIVE_UNTIL", now),
      requiredFutureInstant(env, "INTEGRITY_ARTIFACT_RETAIN_UNTIL", now),
    ],
  };
}

/** The only production composition seam for report publication. Keep the
 * strict constructor above so an enabled deployment cannot degrade to an
 * unanchored fallback because one required policy input is absent. */
export async function deploymentAnchorPublicationIfEnabled(
  env: AnchorEnvironment = process.env,
  now = new Date(),
): Promise<ReportAnchorPublication | undefined> {
  if (!integrityAnchorEnabled(env)) return undefined;
  void now;
  return requireIntegrityAnchorAdmission(env);
}
