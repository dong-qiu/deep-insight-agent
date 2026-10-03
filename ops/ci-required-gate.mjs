import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertRequiredGate({ mode, scope, docs, full }) {
  if (scope !== "success") throw new Error("scope did not succeed");
  if (mode === "docs" && docs === "success" && full === "skipped") return;
  if (mode === "full" && full === "success" && docs === "skipped") return;
  throw new Error(`unexpected downstream results: ${JSON.stringify({ mode, docs, full })}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertRequiredGate({ mode: process.env.MODE, scope: process.env.SCOPE_RESULT, docs: process.env.DOCS_RESULT, full: process.env.FULL_RESULT });
  console.log(`Required check passed via ${process.env.MODE} path`);
}
