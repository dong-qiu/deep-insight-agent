#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ACTIVE_RUN_STATUSES = new Set(["running", "queued"]);
const WATCH_ERROR = Object.freeze({
  QUERY_FAILED: "query failed",
  INVALID_RESPONSE: "invalid response",
});

function usage(exitCode = 0) {
  console.log(`Usage: npm run multica:watch -- [options] <INSI-issue> [...]

Options:
  --pr <number>       Include a GitHub PR (repeatable).
  --interval <sec>    Poll interval in seconds (default: 15; minimum: 5).
  --once              Print one snapshot and exit.
  --until-idle        Exit once all tracked runs and CI checks are idle.
  --help              Show this help.

Example:
  npm run multica:watch -- INSI-91 INSI-94 --pr 291 --until-idle
`);
  process.exit(exitCode);
}

function normalizePrNumber(value) {
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) return undefined;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : undefined;
}

export function parseArgs(argv) {
  const issues = [];
  const prs = [];
  let intervalSeconds = 15;
  let once = false;
  let untilIdle = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") usage();
    if (value === "--once") {
      once = true;
      continue;
    }
    if (value === "--until-idle") {
      untilIdle = true;
      continue;
    }
    if (value === "--pr") {
      const pr = normalizePrNumber(argv[++index]);
      if (!pr) {
        throw new Error("Invalid PR number.");
      }
      prs.push(pr);
      continue;
    }
    if (value === "--interval") {
      const parsed = Number(argv[++index]);
      if (!Number.isFinite(parsed) || parsed < 5) {
        throw new Error("Invalid polling interval.");
      }
      intervalSeconds = parsed;
      continue;
    }
    if (value.startsWith("-")) throw new Error("Invalid option.");
    if (!/^INSI-[1-9]\d*$/.test(value)) throw new Error("Invalid issue identifier.");
    issues.push(value);
  }

  if (issues.length === 0 && prs.length === 0) {
    throw new Error("Provide at least one Multica issue or --pr target.");
  }
  return { issues, prs, intervalSeconds, once, untilIdle };
}

export function commandJson(command, args) {
  try {
    return JSON.parse(
      execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }),
    );
  } catch (error) {
    return { _watchError: error instanceof SyntaxError ? WATCH_ERROR.INVALID_RESPONSE : WATCH_ERROR.QUERY_FAILED };
  }
}

function summarizeChecks(checks = []) {
  const completed = checks.filter((check) => check.status === "COMPLETED").length;
  const failed = checks.filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS").length;
  const active = checks.filter((check) => check.status !== "COMPLETED").length;
  return `${completed}/${checks.length} complete, ${active} active, ${failed} failed`;
}

export function issueSnapshot(identifier) {
  const issue = commandJson("multica", ["issue", "get", identifier]);
  const runs = commandJson("multica", ["issue", "runs", identifier, "--output", "json"]);
  const pullRequests = commandJson("multica", ["issue", "pull-requests", identifier, "--output", "json"]);
  if (issue._watchError || runs._watchError || pullRequests._watchError) return { identifier, issue, runs, pullRequests };
  const latestRun = Array.isArray(runs) ? runs[0] : undefined;
  return { identifier, issue, latestRun, pullRequests };
}

export function prSnapshot(number) {
  const pr = commandJson("gh", ["pr", "view", number, "--json", "state,headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup,url"]);
  return { number, pr };
}

export function activeIssue(snapshot) {
  return (
    Boolean(snapshot.issue?._watchError || snapshot.runs?._watchError || snapshot.pullRequests?._watchError) ||
    ACTIVE_RUN_STATUSES.has(snapshot.latestRun?.status)
  );
}

export function activePr(snapshot) {
  return Boolean(snapshot.pr?._watchError) || (snapshot.pr?.statusCheckRollup?.some((check) => check.status !== "COMPLETED") ?? false);
}

export function printSnapshot({ issues, prs }, poll) {
  const now = new Date().toISOString();
  console.log(`\n[${now}] poll #${poll}`);

  for (const snapshot of issues) {
    if (snapshot.issue._watchError || snapshot.runs?._watchError || snapshot.pullRequests?._watchError) {
      console.log(`  ${snapshot.identifier}: ERROR ${snapshot.issue._watchError ?? snapshot.runs?._watchError ?? snapshot.pullRequests?._watchError}`);
      continue;
    }
    const { issue, latestRun } = snapshot;
    const runText = latestRun
      ? `${latestRun.status}${latestRun.started_at ? ` since ${latestRun.started_at}` : ""}`
      : "no runs";
    const linkedPrNumbers = (snapshot.pullRequests.pull_requests ?? [])
      .map((pr) => normalizePrNumber(pr.number))
      .filter(Boolean);
    const prText = linkedPrNumbers.length === 0 ? "" : ` · linked PR ${linkedPrNumbers.map((number) => `#${number}`).join(", ")}`;
    console.log(`  ${snapshot.identifier}: ${issue.status} · ${issue.assignee_type ?? "unassigned"}:${issue.assignee_id ?? "—"} · latest run ${runText}${prText}`);
  }

  for (const snapshot of prs) {
    const { pr } = snapshot;
    if (pr._watchError) {
      console.log(`  PR #${snapshot.number}: ERROR ${pr._watchError}`);
      continue;
    }
    console.log(`  PR #${snapshot.number}: ${pr.state}/${pr.mergeStateStatus} · head ${pr.headRefOid?.slice(0, 12)} · ${summarizeChecks(pr.statusCheckRollup)}`);
  }
}

export async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage(1);
  }

  let poll = 0;
  const pollOnce = () => {
    poll += 1;
    const issues = options.issues.map(issueSnapshot);
    const prNumbers = new Set(options.prs);
    for (const snapshot of issues) {
      for (const pullRequest of snapshot.pullRequests?.pull_requests ?? []) {
        const number = normalizePrNumber(pullRequest.number);
        if (number) prNumbers.add(number);
      }
    }
    const snapshot = {
      issues,
      prs: [...prNumbers].map(prSnapshot),
    };
    printSnapshot(snapshot, poll);
    return snapshot.issues.some(activeIssue) || snapshot.prs.some(activePr);
  };

  if (options.once) {
    pollOnce();
    return;
  }

  console.log(`Watching every ${options.intervalSeconds}s. Press Ctrl-C to stop.`);
  const initialActive = pollOnce();
  if (options.untilIdle && !initialActive) {
    console.log("All tracked runs and CI checks are idle; watcher exiting.");
    return;
  }

  const timer = setInterval(() => {
    const active = pollOnce();
    if (options.untilIdle && !active) {
      console.log("All tracked runs and CI checks are idle; watcher exiting.");
      clearInterval(timer);
    }
  }, options.intervalSeconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
