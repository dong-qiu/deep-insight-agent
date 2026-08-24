/** Deployment-owned P1c anchor configuration. Application code never falls
 * back to an in-memory store: a publication is either backed by this injected
 * immutable store or is rejected before it can become reader-visible. */
import { createPrivateKey } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { S3AnchorStore, type AnchorStore } from "../db/integrity-anchors.js";
import type { ReportAnchorPublication } from "../db/reports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type AnchorEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: AnchorEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error("integrity_anchor_not_configured");
  return value;
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
  return new S3AnchorStore(new S3Client({}), required(env, "INTEGRITY_ANCHOR_BUCKET"));
}

/** Deployment-owned signer/store injection for the real dispatch path. */
export function deploymentAnchorPublication(
  env: AnchorEnvironment = process.env,
  now = new Date(),
): ReportAnchorPublication {
  const bucket = required(env, "INTEGRITY_ANCHOR_BUCKET");
  const keyId = required(env, "INTEGRITY_ANCHOR_KEY_ID");
  const pem = required(env, "INTEGRITY_ANCHOR_PRIVATE_KEY_PEM").replace(/\\n/g, "\n");
  const artifactDays = env.INTEGRITY_ANCHOR_RETAIN_DAYS == null ? 100 : Number(env.INTEGRITY_ANCHOR_RETAIN_DAYS);
  if (artifactDays != null && (!Number.isInteger(artifactDays) || artifactDays < 1 || artifactDays > 36500)) throw new Error("integrity_anchor_retain_days_invalid");
  let privateKey;
  try { privateKey = createPrivateKey(pem); } catch { throw new Error("integrity_anchor_signer_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("integrity_anchor_signer_invalid");
  return {
    store: new S3AnchorStore(new S3Client({}), bucket),
    signer: { key_id: keyId, private_key: privateKey },
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
