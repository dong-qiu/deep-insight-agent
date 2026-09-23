import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROTOTYPE_POLICY_VERSION } from "../src/lib/runtime/prototype-policy.js";
import { parsePrototypeSafetyReceipt, type PrototypeSafetyReceipt } from "../evals/prototype-safety.js";

export const PROTOTYPE_CI_EVIDENCE_SCHEMA_VERSION = "prototype-ci-evidence-v1";
export const PROTOTYPE_DOCKER_EVIDENCE_SCHEMA_VERSION = "prototype-docker-evidence-v1";
export const PROTOTYPE_RELEASE_RECEIPT_SCHEMA_VERSION = "prototype-release-receipt-v1";

export interface PrototypeCiEvidence {
  schema_version: typeof PROTOTYPE_CI_EVIDENCE_SCHEMA_VERSION;
  /** The immutable source commit a later release receipt may select. */
  commit: string;
  /** The commit GitHub Actions actually checked (a temporary merge ref for PRs). */
  tested_commit: string;
  /** Opaque Actions identifiers only; a process receipt must not persist URLs. */
  run: { id: string; attempt: number };
  /** Written at the end of CI's verify job; Docker remains a separate required CI check. */
  checks: { lint: "pass"; test: "pass"; typecheck: "pass"; build: "pass" };
}

/** Written only by the Docker job after its image and runtime checks pass. */
export interface PrototypeDockerEvidence {
  schema_version: typeof PROTOTYPE_DOCKER_EVIDENCE_SCHEMA_VERSION;
  commit: string;
  tested_commit: string;
  run: { id: string; attempt: number };
  checks: { docker: "pass" };
}

export interface PrototypeReleaseReceipt {
  schema_version: typeof PROTOTYPE_RELEASE_RECEIPT_SCHEMA_VERSION;
  policy_version: typeof PROTOTYPE_POLICY_VERSION;
  stage: "prototype";
  commit: string;
  image_tag: string;
  generated_at: string;
  safety_eval: Pick<PrototypeSafetyReceipt, "run_id" | "model_config_sha256" | "artifacts">;
  ci: { verify: PrototypeCiEvidence; docker: PrototypeDockerEvidence };
  known_limits: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as UnknownRecord;
}

function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): UnknownRecord {
  const result = record(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不匹配`);
  }
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function commit(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error(`${label} 必须是完整 git sha`);
  return result;
}

function githubRunId(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^\d+$/.test(result)) throw new Error(`${label} 必须是 GitHub numeric run id`);
  return result;
}

function run(value: unknown, label: string): { id: string; attempt: number } {
  const evidenceRun = exactRecord(value, label, ["id", "attempt"]);
  const attempt = evidenceRun.attempt;
  if (!Number.isInteger(attempt) || (attempt as number) < 1) throw new Error(`${label}.attempt 无效`);
  return { id: githubRunId(evidenceRun.id, `${label}.id`), attempt: attempt as number };
}

type EvidenceInput = { commit: string; testedCommit?: string; runId: string; runAttempt: number };

/** CI only writes this after all required code checks in the same job have passed. */
export function createPrototypeCiEvidence(input: EvidenceInput): PrototypeCiEvidence {
  if (!Number.isInteger(input.runAttempt) || input.runAttempt < 1) throw new Error("CI run attempt 无效");
  const evidenceRun = { id: githubRunId(input.runId, "CI run id"), attempt: input.runAttempt };
  return {
    schema_version: PROTOTYPE_CI_EVIDENCE_SCHEMA_VERSION,
    commit: commit(input.commit, "CI commit"),
    tested_commit: commit(input.testedCommit ?? input.commit, "CI tested commit"),
    run: evidenceRun,
    checks: { lint: "pass", test: "pass", typecheck: "pass", build: "pass" },
  };
}

export function parsePrototypeCiEvidence(value: unknown): PrototypeCiEvidence {
  const evidence = exactRecord(value, "prototype CI evidence", ["schema_version", "commit", "tested_commit", "run", "checks"]);
  if (evidence.schema_version !== PROTOTYPE_CI_EVIDENCE_SCHEMA_VERSION) throw new Error("prototype CI evidence schema 不匹配");
  const evidenceRun = run(evidence.run, "prototype CI evidence.run");
  const checks = exactRecord(evidence.checks, "prototype CI evidence.checks", ["lint", "test", "typecheck", "build"]);
  for (const key of ["lint", "test", "typecheck", "build"] as const) {
    if (checks[key] !== "pass") throw new Error(`prototype CI evidence ${key} 未通过`);
  }
  return {
    schema_version: PROTOTYPE_CI_EVIDENCE_SCHEMA_VERSION,
    commit: commit(evidence.commit, "prototype CI evidence.commit"),
    tested_commit: commit(evidence.tested_commit, "prototype CI evidence.tested_commit"),
    run: evidenceRun,
    checks: { lint: "pass", test: "pass", typecheck: "pass", build: "pass" },
  };
}

export function createPrototypeDockerEvidence(input: EvidenceInput): PrototypeDockerEvidence {
  if (!Number.isInteger(input.runAttempt) || input.runAttempt < 1) throw new Error("Docker run attempt 无效");
  return {
    schema_version: PROTOTYPE_DOCKER_EVIDENCE_SCHEMA_VERSION,
    commit: commit(input.commit, "Docker commit"),
    tested_commit: commit(input.testedCommit ?? input.commit, "Docker tested commit"),
    run: { id: githubRunId(input.runId, "Docker run id"), attempt: input.runAttempt },
    checks: { docker: "pass" },
  };
}

export function parsePrototypeDockerEvidence(value: unknown): PrototypeDockerEvidence {
  const evidence = exactRecord(value, "prototype Docker evidence", ["schema_version", "commit", "tested_commit", "run", "checks"]);
  if (evidence.schema_version !== PROTOTYPE_DOCKER_EVIDENCE_SCHEMA_VERSION) throw new Error("prototype Docker evidence schema 不匹配");
  const checks = exactRecord(evidence.checks, "prototype Docker evidence.checks", ["docker"]);
  if (checks.docker !== "pass") throw new Error("prototype Docker evidence docker 未通过");
  return {
    schema_version: PROTOTYPE_DOCKER_EVIDENCE_SCHEMA_VERSION,
    commit: commit(evidence.commit, "prototype Docker evidence.commit"),
    tested_commit: commit(evidence.tested_commit, "prototype Docker evidence.tested_commit"),
    run: run(evidence.run, "prototype Docker evidence.run"),
    checks: { docker: "pass" },
  };
}

/** Bind a safe model-eval receipt and a CI pass to the exact image tag a deployment may select. */
export function createPrototypeReleaseReceipt(input: {
  commit: string;
  safetyReceipt: unknown;
  ciEvidence: unknown;
  dockerEvidence: unknown;
  generatedAt?: string;
}): PrototypeReleaseReceipt {
  const expectedCommit = commit(input.commit, "release commit");
  const safety = parsePrototypeSafetyReceipt(input.safetyReceipt);
  const ci = parsePrototypeCiEvidence(input.ciEvidence);
  const docker = parsePrototypeDockerEvidence(input.dockerEvidence);
  if (safety.source.commit !== expectedCommit || ci.commit !== expectedCommit || docker.commit !== expectedCommit) {
    throw new Error("prototype release receipt 的 safety/CI/Docker evidence 必须绑定同一 commit");
  }
  if (ci.run.id !== docker.run.id || ci.run.attempt !== docker.run.attempt || ci.tested_commit !== docker.tested_commit) {
    throw new Error("prototype release receipt 的 CI/Docker evidence 必须来自同一测试运行");
  }
  return {
    schema_version: PROTOTYPE_RELEASE_RECEIPT_SCHEMA_VERSION,
    policy_version: PROTOTYPE_POLICY_VERSION,
    stage: "prototype",
    commit: expectedCommit,
    image_tag: `sha-${expectedCommit}`,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    safety_eval: {
      run_id: safety.run_id,
      model_config_sha256: safety.model_config_sha256,
      artifacts: safety.artifacts,
    },
    ci: { verify: ci, docker },
    known_limits: [
      "internal_authenticated_prototype_only",
      "source_terms_deferred_not_authorization",
      "no_public_raw_content_api_or_training_use",
      "no_formal_baseline_or_dcp_claim",
    ],
  };
}

export function writePrototypeReleaseArtifact(path: string, value: PrototypeCiEvidence | PrototypeDockerEvidence | PrototypeReleaseReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
