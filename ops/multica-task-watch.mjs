#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const ACTIVE_RUN_STATUSES = new Set(["running", "queued"]);

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

function parseArgs(argv) {
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
      const pr = argv[++index];
      if (!/^\d+$/.test(pr ?? "")) throw new Error("--pr requires a PR number.");
      prs.push(pr);
      continue;
    }
    if (value === "--interval") {
      const parsed = Number(argv[++index]);
      if (!Number.isFinite(parsed) || parsed < 5) {
        throw new Error("--interval must be at least 5 seconds.");
      }
      intervalSeconds = parsed;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    issues.push(value);
  }

  if (issues.length === 0 && prs.length === 0) {
    throw new Error("Provide at least one Multica issue or --pr target.");
  }
  return { issues, prs, intervalSeconds, once, untilIdle };
}

function commandJson(command, args) {
  try {
    return JSON.parse(
      execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }),
    );
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    return { _watchError: `${command} ${args.join(" ")}: ${detail}` };
  }
}

function summarizeChecks(checks = []) {
  const completed = checks.filter((check) => check.status === "COMPLETED").length;
  const failed = checks.filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS").length;
  const active = checks.filter((check) => check.status !== "COMPLETED").length;
  return `${completed}/${checks.length} complete, ${active} active, ${failed} failed`;
}

function issueSnapshot(identifier) {
  const issue = commandJson("multica", ["issue", "get", identifier]);
  const runs = commandJson("multica", ["issue", "runs", identifier, "--output", "json"]);
  const pullRequests = commandJson("multica", ["issue", "pull-requests", identifier, "--output", "json"]);
  if (issue._watchError || runs._watchError || pullRequests._watchError) return { identifier, issue, runs, pullRequests };
  const latestRun = Array.isArray(runs) ? runs[0] : undefined;
  return { identifier, issue, latestRun, pullRequests };
}

function prSnapshot(number) {
  const pr = commandJson("gh", ["pr", "view", number, "--json", "state,headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup,url"]);
  return { number, pr };
}

function activeIssue(snapshot) {
  return (
    Boolean(snapshot.issue?._watchError || snapshot.runs?._watchError || snapshot.pullRequests?._watchError) ||
    ACTIVE_RUN_STATUSES.has(snapshot.latestRun?.status)
  );
}

function activePr(snapshot) {
  return Boolean(snapshot.pr?._watchError) || (snapshot.pr?.statusCheckRollup?.some((check) => check.status !== "COMPLETED") ?? false);
}

function printSnapshot({ issues, prs }, poll) {
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
    const linkedPrs = snapshot.pullRequests.pull_requests ?? [];
    const prText = linkedPrs.length === 0 ? "" : ` · linked PR ${linkedPrs.map((pr) => `#${pr.number}`).join(", ")}`;
    console.log(`  ${issue.identifier}: ${issue.status} · ${issue.assignee_type ?? "unassigned"}:${issue.assignee_id ?? "—"} · latest run ${runText}${prText}`);
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

async function main() {
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
        prNumbers.add(String(pullRequest.number));
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

main();
