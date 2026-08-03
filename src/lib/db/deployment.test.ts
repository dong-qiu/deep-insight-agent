import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { assertDeploymentIdentity, recordDeployment } from "./deployment.js";
import { applyProvenanceMigrations } from "./provenance-migrations.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("deployment identity", () => {
  it("rejects strict startup when no resolved OCI digest was injected", () => {
    const db = openDb(":memory:");
    try {
      applyProvenanceMigrations(db);
      delete process.env.INSIGHT_IMAGE_DIGEST;
      expect(() => assertDeploymentIdentity(db)).toThrow("deployment_identity_missing_digest");
    } finally {
      db.close();
    }
  });

  it("accepts a matching resolved digest, immutable record, and build SHA", () => {
    const directory = mkdtempSync(join(tmpdir(), "insight-deployment-"));
    const buildInfo = join(directory, "build-info.json");
    const digest = `sha256:${"a".repeat(64)}`;
    const gitSha = "b".repeat(40);
    const db = openDb(":memory:");
    try {
      applyProvenanceMigrations(db);
      writeFileSync(buildInfo, JSON.stringify({ git_sha: gitSha }));
      recordDeployment(db, { imageDigest: digest, gitSha, actor: "test" });
      process.env.INSIGHT_IMAGE_DIGEST = digest;
      process.env.BUILD_INFO_PATH = buildInfo;
      expect(() => assertDeploymentIdentity(db)).not.toThrow();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an image whose injected digest does not match the latest record", () => {
    const directory = mkdtempSync(join(tmpdir(), "insight-deployment-"));
    const buildInfo = join(directory, "build-info.json");
    const gitSha = "c".repeat(40);
    const db = openDb(":memory:");
    try {
      applyProvenanceMigrations(db);
      writeFileSync(buildInfo, JSON.stringify({ git_sha: gitSha }));
      recordDeployment(db, { imageDigest: `sha256:${"d".repeat(64)}`, gitSha, actor: "test" });
      process.env.INSIGHT_IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;
      process.env.BUILD_INFO_PATH = buildInfo;
      expect(() => assertDeploymentIdentity(db)).toThrow("deployment_identity_mismatch");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
