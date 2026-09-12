#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const THRESHOLD = 50;
const DEFAULT_INTERVAL_SECONDS = 900;
const MIN_INTERVAL_SECONDS = 300;
const TERMINAL_STATUSES = new Set(["Success", "Failed", "TimedOut", "Cancelled"]);

function usage(exitCode = 0) {
  console.log(`Usage: npm run p0:observe -- [options]

Read only the production aggregate used to observe prospective P0-1 dogfood
readiness. It never triggers a pipeline, exports records, or writes production data.

Options:
  --watch                         Keep printing aggregate progress in this terminal.
  --interval <seconds>            Watch interval (default: ${DEFAULT_INTERVAL_SECONDS}; minimum: ${MIN_INTERVAL_SECONDS}).
  --until-candidate-threshold     Exit after the conservative candidate count reaches ${THRESHOLD}.
  --help                          Show this help.

The candidate count is deliberately conservative but is not the dogfood gate.
After it reaches ${THRESHOLD}, create a fresh private snapshot and run
eval:opportunity-export; only that strict export may open INSI-180.
`);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  let watch = false;
  let untilCandidateThreshold = false;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") usage();
    if (value === "--watch") {
      watch = true;
      continue;
    }
    if (value === "--until-candidate-threshold") {
      untilCandidateThreshold = true;
      continue;
    }
    if (value === "--interval") {
      const parsed = Number(argv[++index]);
      if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_SECONDS) {
        throw new Error(`--interval must be an integer of at least ${MIN_INTERVAL_SECONDS} seconds.`);
      }
      intervalSeconds = parsed;
      continue;
    }
    throw new Error("Invalid option.");
  }

  if (untilCandidateThreshold && !watch) {
    throw new Error("--until-candidate-threshold requires --watch.");
  }
  return { watch, untilCandidateThreshold, intervalSeconds };
}

function commandOutput(command, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }).trim();
  } catch {
    if (allowFailure) return null;
    throw new Error("command_failed");
  }
}

function productionContext() {
  const instanceId = readFileSync(resolve("ops/aws/.vm-id"), "utf8").trim();
  if (!/^i-[a-z0-9]+$/.test(instanceId)) throw new Error("invalid_instance_id");
  const region = commandOutput("zsh", ["-lc", "source ops/aws/config.sh; printf '%s' \"$AWS_REGION\""]);
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(region)) throw new Error("invalid_region");
  return { instanceId, region };
}

export function remoteAggregateProgram() {
  // This SQL is intentionally a *candidate* prefilter. The authoritative human-gate
  // check remains eval:opportunity-export against a fresh private snapshot.
  return `const Database=require('better-sqlite3');
const db=new Database('/data/insight.db',{readonly:true});
const result=db.prepare(\`SELECT
  (SELECT COUNT(*) FROM tech_lead) AS total_tech_leads,
  COUNT(DISTINCT CASE WHEN b.status='done'
    AND b.display_coverage_state='audited'
    AND b.display_projection_version='source_quote_v1'
    AND d.terminal_reason IN ('kept','kept_degraded')
    AND cc.verdict='pass' AND cc.consistency='support' AND cc.reachability='pass'
    AND c.reader_eligible=1
    AND e.citation_index=i.statement_citation_index-1
    THEN e.lead_id END) AS candidate_source_quote_v1
FROM tech_lead_evidence e
JOIN insight i ON i.id=e.insight_id
JOIN analysis_batch b ON b.id=i.batch_id
JOIN display_coverage_audit d ON d.batch_id=b.id AND d.insight_id=i.id
JOIN citation ci ON ci.insight_id=e.insight_id AND ci.citation_index=e.citation_index
JOIN citation_check cc ON cc.batch_id=b.id AND cc.insight_id=ci.insight_id AND cc.citation_index=ci.citation_index
JOIN content_item c ON c.id=ci.content_item_id\`).get();
console.log(JSON.stringify(result));`;
}

export function remoteCommandForAggregate() {
  const encoded = Buffer.from(remoteAggregateProgram(), "utf8").toString("base64");
  return `set -eu; docker exec deep-insight-app-1 sh -lc 'node -e "$(printf %s ${encoded} | base64 -d)"'`;
}

function invokeAggregate({ instanceId, region }) {
  const parameters = JSON.stringify({
    commands: [remoteCommandForAggregate()],
    executionTimeout: ["45"],
  });
  const commandId = commandOutput("aws", [
    "ssm", "send-command", "--region", region, "--instance-ids", instanceId,
    "--document-name", "AWS-RunShellScript", "--comment", "Read-only P0 forward observation",
    "--timeout-seconds", "60", "--parameters", parameters,
    "--query", "Command.CommandId", "--output", "text",
  ]);
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new Error("invalid_command_id");

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const responseText = commandOutput("aws", [
      "ssm", "get-command-invocation", "--region", region, "--command-id", commandId,
      "--instance-id", instanceId, "--output", "json",
    ], { allowFailure: true });
    if (responseText === null) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
      continue;
    }
    let response;
    try { response = JSON.parse(responseText); } catch { throw new Error("invalid_ssm_response"); }
    if (!TERMINAL_STATUSES.has(response.Status)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
      continue;
    }
    if (response.Status !== "Success") throw new Error("ssm_command_failed");
    try {
      const aggregate = JSON.parse(String(response.StandardOutputContent ?? "").trim());
      if (!Number.isSafeInteger(aggregate.total_tech_leads)
        || !Number.isSafeInteger(aggregate.candidate_source_quote_v1)
        || aggregate.total_tech_leads < 0
        || aggregate.candidate_source_quote_v1 < 0) throw new Error("invalid_aggregate");
      return aggregate;
    } catch {
      throw new Error("invalid_aggregate");
    }
  }
  throw new Error("ssm_command_timeout");
}

export function formatSnapshot(aggregate, observedAt = new Date().toISOString()) {
  const candidateReady = aggregate.candidate_source_quote_v1 >= THRESHOLD;
  const nextAction = candidateReady
    ? "candidate threshold reached; create a fresh private snapshot, then run eval:opportunity-export before opening INSI-180"
    : "wait for the next normal production pipeline; do not replay history or start INSI-180";
  return `[${observedAt}] P0-1 forward observation\n`
    + `  stored TechLeads: ${aggregate.total_tech_leads}\n`
    + `  source_quote_v1 evidence-ready candidates: ${aggregate.candidate_source_quote_v1}/${THRESHOLD}\n`
    + `  candidate threshold: ${candidateReady ? "reached" : "not reached"}\n`
    + `  next action: ${nextAction}`;
}

export async function main({ argv = process.argv.slice(2), context = productionContext, observe = invokeAggregate } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage(1);
  }

  const poll = () => {
    try {
      const aggregate = observe(context());
      console.log(formatSnapshot(aggregate));
      return aggregate.candidate_source_quote_v1 >= THRESHOLD;
    } catch {
      console.log(`[${new Date().toISOString()}] P0-1 forward observation: unavailable; retaining prior state and retrying on the next poll.`);
      return false;
    }
  };

  const reached = poll();
  if (!options.watch || (options.untilCandidateThreshold && reached)) return;
  console.log(`Watching every ${options.intervalSeconds}s. Press Ctrl-C to stop.`);
  const timer = setInterval(() => {
    if (poll() && options.untilCandidateThreshold) clearInterval(timer);
  }, options.intervalSeconds * 1_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
