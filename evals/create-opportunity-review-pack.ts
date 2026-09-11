/** Build an Owner-private review pack from explicit offline files only. */
import { readFileSync, writeFileSync } from "node:fs";
import { createOwnerReviewPack } from "./technology-opportunities/review-pack-v1.js";
import type { BlindSampleManifest, QualifiedTechLeadSnapshot } from "./technology-opportunities/dogfood-v2.js";

const [snapshotPath, manifestPath, seed, outputPath] = process.argv.slice(2);
if (!snapshotPath || !manifestPath || !seed || !outputPath) {
  throw new Error("Usage: tsx evals/create-opportunity-review-pack.ts <qualified-snapshot.json> <blind-manifest.json> <seed> <owner-review-pack.json>");
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as QualifiedTechLeadSnapshot;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BlindSampleManifest;
const pack = createOwnerReviewPack(snapshot, manifest, seed);
writeFileSync(outputPath, `${JSON.stringify(pack, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
