import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DB } from "./index.js";

export function recordDeployment(db: DB, input: { imageDigest: string; gitSha: string; actor: string; deployedAt?: string }): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !/^[0-9a-f]{7,64}$/i.test(input.gitSha)) throw new Error("deployment_identity_invalid");
  db.prepare("INSERT INTO deployment_record(id,image_digest,git_sha,deployed_at,actor) VALUES (?,?,?,?,?)")
    .run(`deploy_${randomUUID().replaceAll("-", "")}`, input.imageDigest, input.gitSha, input.deployedAt ?? new Date().toISOString(), input.actor);
}

/** 严格生产模式三方校验：环境 digest、最新部署记录、镜像 build-info Git SHA。 */
export function assertDeploymentIdentity(db: DB): void {
  const digest = process.env.INSIGHT_IMAGE_DIGEST;
  if (!digest) throw new Error("deployment_identity_missing_digest");
  const infoPath = process.env.BUILD_INFO_PATH ?? "/app/build-info.json";
  if (!existsSync(infoPath)) throw new Error("deployment_identity_missing_build_info");
  const gitSha = (JSON.parse(readFileSync(infoPath, "utf8")) as { git_sha?: unknown }).git_sha;
  if (typeof gitSha !== "string" || gitSha === "unknown") throw new Error("deployment_identity_invalid_build_info");
  const row = db.prepare("SELECT image_digest,git_sha FROM deployment_record ORDER BY deployed_at DESC,id DESC LIMIT 1").get() as { image_digest: string; git_sha: string } | undefined;
  if (!row || row.image_digest !== digest || row.git_sha !== gitSha) throw new Error("deployment_identity_mismatch");
}
