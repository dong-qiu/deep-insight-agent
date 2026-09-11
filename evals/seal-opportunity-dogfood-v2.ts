/** Produce the expected-only commitment before any actual mapping is read. */
import { readFileSync, writeFileSync } from "node:fs";
import { createSealedExpectedArtifact, type BlindSampleManifest, type ExpectedLabel } from "./technology-opportunities/dogfood-v2.js";

const [manifestPath, expectedPath, outputPath, sealedAt] = process.argv.slice(2);
if (!manifestPath || !expectedPath || !outputPath || !sealedAt) throw new Error("Usage: tsx evals/seal-opportunity-dogfood-v2.ts <blind-manifest.json> <expected-only.json> <sealed.json> <sealed-at-utc>");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BlindSampleManifest;
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ExpectedLabel[];
writeFileSync(outputPath, `${JSON.stringify(createSealedExpectedArtifact(manifest, expected, sealedAt), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
