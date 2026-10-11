import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const identityKeys = ["commit", "tested_commit", "repository", "event", "run_id", "run_attempt"];
const sha = /^[0-9a-f]{40}$/;

function assertIdentity(identity) {
  if (!identity || ![identity.commit, identity.tested_commit].every(s => typeof s === "string" && sha.test(s) && !/^0+$/.test(s)) ||
    !/^[^/\s]+\/[^/\s]+$/.test(identity.repository ?? "") || !["push", "pull_request"].includes(identity.event) ||
    typeof identity.run_id !== "string" || !/^[1-9][0-9]*$/.test(identity.run_id) ||
    !Number.isSafeInteger(identity.run_attempt) || identity.run_attempt < 1) throw new Error("invalid application CI identity");
  if (identity.event === "push" && identity.commit !== identity.tested_commit) throw new Error("push candidate differs from tested commit");
}

export function identityFromEnvironment(env = process.env, cwd = process.cwd()) {
  const identity = {
    commit: env.PROTOTYPE_CI_EVIDENCE_COMMIT,
    tested_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    repository: env.GITHUB_REPOSITORY,
    event: env.GITHUB_EVENT_NAME,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  assertIdentity(identity);
  if (identity.tested_commit !== env.GITHUB_SHA) throw new Error("checkout differs from event SHA");
  return identity;
}

/** Only call in the last successful step of a lane; the job result is checked separately. */
export function laneIdentity(lane, identity) {
  if (!["application", "ops"].includes(lane)) throw new Error("invalid application lane");
  assertIdentity(identity);
  return { ...identity, lane };
}

export function assertApplicationGate(needs, expected) {
  assertIdentity(expected);
  if (needs?.scope?.result !== "success" || needs.scope.outputs?.mode !== "full") throw new Error("full scope did not succeed");
  for (const [job, lane] of [["application_checks", "application"], ["ops_checks", "ops"]]) {
    const upstream = needs[job];
    if (upstream?.result !== "success") throw new Error(`application lane did not succeed: ${job}`);
    let actual;
    try { actual = JSON.parse(upstream.outputs.identity); }
    catch { throw new Error(`missing or invalid lane identity: ${job}`); }
    if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify([...identityKeys, "lane"].sort()) || actual.lane !== lane ||
      identityKeys.some(key => actual[key] !== expected[key])) throw new Error(`lane identity mismatch: ${job}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = identityFromEnvironment();
  if (process.argv[2] === "record" && process.argv.length === 4) {
    const identity = laneIdentity(process.argv[3], expected);
    appendFileSync(process.env.GITHUB_OUTPUT, `identity=${JSON.stringify(identity)}\n`);
    console.log(`Verified ${identity.lane} checkout ${identity.tested_commit}, run ${identity.run_id}/${identity.run_attempt}`);
  } else if (process.argv[2] === "verify" && process.argv.length === 3) {
    assertApplicationGate(JSON.parse(process.env.NEEDS_JSON), expected);
    console.log(`Both application lanes passed for ${expected.tested_commit}, run ${expected.run_id}/${expected.run_attempt}`);
  } else throw new Error("usage: ci-application-gate.mjs record <application|ops> | verify");
}
