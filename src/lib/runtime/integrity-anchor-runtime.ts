/** Deployment-owned P1c anchor configuration. Application code never falls
 * back to an in-memory store: a publication is either backed by this injected
 * immutable store or is rejected before it can become reader-visible. */
import { createPrivateKey } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { S3AnchorStore } from "../db/integrity-anchors.js";
import type { ReportAnchorPublication } from "../db/reports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type AnchorEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: AnchorEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error("integrity_anchor_not_configured");
  return value;
}

/** Deployment-owned signer/store injection for the real dispatch path. */
export function deploymentAnchorPublication(
  env: AnchorEnvironment = process.env,
  now = new Date(),
): ReportAnchorPublication {
  const bucket = required(env, "INTEGRITY_ANCHOR_BUCKET");
  const keyId = required(env, "INTEGRITY_ANCHOR_KEY_ID");
  const pem = required(env, "INTEGRITY_ANCHOR_PRIVATE_KEY_PEM").replace(/\\n/g, "\n");
  const retainDays = Number(env.INTEGRITY_ANCHOR_RETAIN_DAYS ?? "365");
  if (!Number.isInteger(retainDays) || retainDays < 1 || retainDays > 36500) throw new Error("integrity_anchor_retain_days_invalid");
  let privateKey;
  try { privateKey = createPrivateKey(pem); } catch { throw new Error("integrity_anchor_signer_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("integrity_anchor_signer_invalid");
  return {
    store: new S3AnchorStore(new S3Client({}), bucket),
    signer: { key_id: keyId, private_key: privateKey },
    retainUntil: new Date(now.getTime() + retainDays * DAY_MS).toISOString(),
  };
}
