import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/lib/db/index.js";
import { recordDeployment } from "../src/lib/db/deployment.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";

// Local Compose deliberately has no immutable image identity.  Production sets the
// explicit gate; a successful no-op here keeps the local development topology usable.
if (process.env.PROVENANCE_DEPLOYMENT_REQUIRED !== "1") {
  console.info("deployment_record skipped (development mode)");
  process.exit(0);
}

// This one-shot writer is the only strict-mode process permitted to open the new
// database before its own deployment record exists.
process.env.PROVENANCE_DEPLOYMENT_WRITER = "1";
const buildInfoPath = process.env.BUILD_INFO_PATH ?? "/app/build-info.json";
const buildGitSha = existsSync(buildInfoPath)
  ? (JSON.parse(readFileSync(buildInfoPath, "utf8")) as { git_sha?: unknown }).git_sha
  : undefined;
const gitSha = process.env.GIT_SHA ?? (typeof buildGitSha === "string" ? buildGitSha : "");

const db = openDb(process.env.DB_PATH ?? ".data/insight.db");
applyProvenanceMigrations(db);
recordDeployment(db, { imageDigest: process.env.INSIGHT_IMAGE_DIGEST ?? "", gitSha, actor: process.env.DEPLOY_ACTOR ?? "deploy" });
db.close();
