import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRange } from "./ci-change-scope.mjs";

export function assertTrustedRun(run, event, repository) {
  if (run.id !== event.id || run.run_attempt !== event.run_attempt ||
    run.head_sha !== event.head_sha || !/^[0-9a-f]{40}$/.test(run.head_sha) ||
    !Number.isInteger(run.id) || !Number.isInteger(run.run_attempt) || run.run_attempt < 1 ||
    run.status !== "completed" || run.conclusion !== "success" || run.event !== "push" ||
    run.head_branch !== "main" || run.path !== ".github/workflows/ci.yml" || run.name !== "CI" ||
    run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
    run.repository?.id !== run.head_repository?.id) throw new Error("untrusted or unsuccessful CI run identity");
}

export function assertPublishAdmission({ run, event, repository, scope, jobs, ci, docker, cwd = process.cwd() }) {
  assertTrustedRun(run, event, repository);
  if (scope.schema_version !== "ci-change-scope-v1" || scope.repository !== repository || scope.event !== "push" ||
    scope.head !== run.head_sha || scope.tested_commit !== run.head_sha ||
    scope.run?.id !== String(run.id) || scope.run?.attempt !== run.run_attempt || !["full", "docs"].includes(scope.mode)) throw new Error("scope identity mismatch");
  const classified = classifyRange({ cwd, event: "push", base: scope.base, head: scope.head, tested: scope.tested_commit });
  if (classified.mode !== scope.mode || JSON.stringify(classified.changes) !== JSON.stringify(scope.changes)) throw new Error("scope differs from immutable Git range");
  function job(name, conclusion) {
    const matches = jobs.filter(j => j.name === name);
    if (matches.length !== 1 || matches[0].head_sha !== run.head_sha || matches[0].status !== "completed" || matches[0].conclusion !== conclusion || matches[0].run_attempt !== run.run_attempt) throw new Error(`missing/failed/mismatched job: ${name}`);
  }
  for (const name of ["classify change scope", "typecheck · test · build", "docker build", "eval-gate (trailer)"]) job(name, "success");
  job("documentation checks", scope.mode === "docs" ? "success" : "skipped");
  for (const name of ["full application verification", "full Docker verification"]) job(name, scope.mode === "full" ? "success" : "skipped");
  if (scope.mode === "docs") return false;
  for (const [evidence, schema, keys] of [[ci, "prototype-ci-evidence-v1", ["lint", "test", "typecheck", "build"]], [docker, "prototype-docker-evidence-v1", ["docker"]]]) {
    if (!evidence || evidence.schema_version !== schema || evidence.commit !== run.head_sha || evidence.tested_commit !== run.head_sha ||
      evidence.run?.id !== String(run.id) || evidence.run?.attempt !== run.run_attempt ||
      JSON.stringify(Object.keys(evidence.checks ?? {}).sort()) !== JSON.stringify([...keys].sort()) || keys.some(k => evidence.checks[k] !== "pass")) throw new Error("missing or mismatched full verification evidence");
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = p => JSON.parse(readFileSync(p, "utf8"));
  const dir = process.argv[2], metadata = read(process.argv[3]);
  const scope = read(`${dir}/scope/ci-change-scope.json`);
  const publish = assertPublishAdmission({ ...metadata, scope,
    ci: scope.mode === "full" ? read(`${dir}/ci/prototype-ci-evidence.json`) : undefined,
    docker: scope.mode === "full" ? read(`${dir}/docker/prototype-docker-evidence.json`) : undefined });
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CI ${metadata.run.id} attempt ${metadata.run.run_attempt}, SHA ${metadata.run.head_sha}: ${publish ? "full verification; image publish admitted" : "documentation only; image build/publish skipped"}.\n`);
}
