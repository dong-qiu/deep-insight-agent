/** Read-only local presentation. No model calls, environment loading or database access. */
import { readFileSync } from "node:fs";
import { presentA1Status } from "./a1-observability.js";

const path = process.argv[2];
try {
  const manifest = path ? JSON.parse(readFileSync(path, "utf8")) as unknown : null;
  if (path && (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) throw new Error("invalid manifest");
  console.log(JSON.stringify(presentA1Status(manifest as Record<string, unknown> | null), null, 2));
} catch {
  console.error("A1 status: artifact_unreadable");
  process.exitCode = 1;
}
