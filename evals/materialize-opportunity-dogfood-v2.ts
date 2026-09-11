/** Private step: combine a sealed expected artifact with actual mappings from the same snapshot. */
import { readFileSync, writeFileSync } from "node:fs";
import { materializeActualLabels, type BlindSampleManifest, type DeterministicMappingExport, type QualifiedTechLeadSnapshot, type SealedExpectedArtifact } from "./technology-opportunities/dogfood-v2.js";

const [snapshotPath, manifestPath, sealedPath, mappingPath, outputPath, generatedAt] = process.argv.slice(2);
if (!snapshotPath || !manifestPath || !sealedPath || !mappingPath || !outputPath || !generatedAt) throw new Error("Usage: tsx evals/materialize-opportunity-dogfood-v2.ts <qualified-snapshot.json> <blind-manifest.json> <sealed.json> <deterministic-mapping.json> <labels.json> <generated-at-utc>");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as QualifiedTechLeadSnapshot;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BlindSampleManifest;
const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedExpectedArtifact;
const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as DeterministicMappingExport;
writeFileSync(outputPath, `${JSON.stringify(materializeActualLabels(snapshot, manifest, sealed, mapping, generatedAt), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
