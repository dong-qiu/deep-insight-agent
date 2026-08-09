#!/usr/bin/env node
/**
 * 清理已合并 PR 的本地短生命周期分支与 linked worktree。
 *
 * 默认 dry-run；远程分支由 GitHub 的 delete_branch_on_merge 管理。
 * 依赖已登录的 GitHub CLI，只读取 merged PR 和本地 Git 元数据；--apply 才写入本地 Git 状态。
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

function command(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function parseWorktrees(input) {
  const entries = [];
  let current = null;
  for (const line of input.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, locked: false, isMain: entries.length === 0 };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line.startsWith("locked")) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function pathContains(root, child) {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  try { return realpathSync.native(value); } catch { return path.resolve(value); }
}

export function planCleanup({ mergedPulls, localBranches, worktrees, cwd, statusForWorktree, defaultBranch, repository }) {
  const mergedByBranch = new Map(
    mergedPulls
      .filter((pr) => pr.headRepository?.nameWithOwner === repository)
      .map((pr) => [pr.headRefName, pr]),
  );
  const occupied = new Map(worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch, worktree]));
  const candidates = [];
  const skipped = [];

  for (const [branch, sha] of localBranches) {
    if (branch === defaultBranch) continue;
    const pr = mergedByBranch.get(branch);
    if (!pr) {
      skipped.push({ branch, reason: "no_merged_pull_request" });
      continue;
    }
    if (sha !== pr.headRefOid) {
      skipped.push({ branch, reason: "branch_advanced_after_merge" });
      continue;
    }
    const worktree = occupied.get(branch);
    if (!worktree) {
      candidates.push({ branch, action: "delete_branch" });
      continue;
    }
    if (worktree.isMain) {
      skipped.push({ branch, reason: "main_worktree", worktree: worktree.path });
      continue;
    }
    if (worktree.locked) {
      skipped.push({ branch, reason: "worktree_locked", worktree: worktree.path });
      continue;
    }
    if (pathContains(worktree.path, cwd)) {
      skipped.push({ branch, reason: "current_worktree", worktree: worktree.path });
      continue;
    }
    if (statusForWorktree(worktree.path).trim()) {
      skipped.push({ branch, reason: "worktree_dirty", worktree: worktree.path });
      continue;
    }
    candidates.push({ branch, action: "remove_worktree_then_delete_branch", worktree: worktree.path });
  }
  return { candidates, skipped };
}

function localBranches() {
  // Git ref names cannot contain spaces, so a literal space is a stable delimiter here.
  const output = command("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]).stdout;
  return new Map(output.trim().split("\n").filter(Boolean).map((line) => {
    const [branch, sha] = line.split(" ");
    return [branch, sha];
  }));
}

function mergedPullRequests() {
  const output = command("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "headRefName,headRefOid,headRepository,mergedAt"]).stdout;
  return JSON.parse(output);
}

function repositoryInfo() {
  const output = command("gh", ["repo", "view", "--json", "defaultBranchRef,nameWithOwner"]).stdout;
  const repo = JSON.parse(output);
  if (!repo.defaultBranchRef?.name || !repo.nameWithOwner) throw new Error("GitHub repository metadata is incomplete");
  return { defaultBranch: repo.defaultBranchRef.name, repository: repo.nameWithOwner };
}

function printPlan(plan, apply) {
  console.log(`${apply ? "Apply" : "Dry run"}: GitHub manages remote head-branch deletion; this command only changes local worktrees/branches.`);
  if (!plan.candidates.length) console.log("No local cleanup candidates.");
  for (const candidate of plan.candidates) {
    const worktree = candidate.worktree ? ` (${candidate.worktree})` : "";
    console.log(`candidate\t${candidate.action}\t${candidate.branch}${worktree}`);
  }
  for (const skipped of plan.skipped) {
    const worktree = skipped.worktree ? ` (${skipped.worktree})` : "";
    console.log(`skipped\t${skipped.reason}\t${skipped.branch}${worktree}`);
  }
}

export function main(args = process.argv.slice(2)) {
  const apply = args.includes("--apply");
  if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: npm run branches:cleanup [-- --apply]");
  const repo = repositoryInfo();
  const plan = planCleanup({
    mergedPulls: mergedPullRequests(),
    localBranches: localBranches(),
    worktrees: parseWorktrees(command("git", ["worktree", "list", "--porcelain"]).stdout)
      .map((worktree) => ({ ...worktree, path: canonicalPath(worktree.path) })),
    cwd: canonicalPath(command("git", ["rev-parse", "--show-toplevel"]).stdout.trim()),
    statusForWorktree: (worktree) => command("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"]).stdout,
    defaultBranch: repo.defaultBranch,
    repository: repo.repository,
  });
  printPlan(plan, apply);
  if (!apply) return;

  for (const candidate of plan.candidates) {
    if (candidate.worktree) command("git", ["worktree", "remove", candidate.worktree]);
    command("git", ["branch", "-D", candidate.branch]);
    console.log(`deleted\t${candidate.branch}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
