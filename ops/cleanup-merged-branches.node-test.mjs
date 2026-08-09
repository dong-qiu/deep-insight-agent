import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktrees, planCleanup } from "./cleanup-merged-branches.mjs";

test("parses linked worktree metadata", () => {
  assert.deepEqual(parseWorktrees("worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /feature\nHEAD bbb\nbranch refs/heads/feat/a\nlocked keep-investigation\n"), [
    { path: "/repo", branch: "main", locked: false, isMain: true },
    { path: "/feature", branch: "feat/a", locked: true, isMain: false },
  ]);
});

test("only plans a clean, unchanged merged PR worktree", () => {
  const plan = planCleanup({
    mergedPulls: [{ headRefName: "feat/merged", headRefOid: "abc", headRepository: { id: "repo-id", nameWithOwner: "" } }],
    localBranches: new Map([["main", "base"], ["feat/merged", "abc"], ["feat/advanced", "new"]]),
    worktrees: [{ path: "/repo", branch: "main", locked: false, isMain: true }, { path: "/feature", branch: "feat/merged", locked: false, isMain: false }],
    cwd: "/repo",
    statusForWorktree: () => "",
    defaultBranch: "main",
    repositoryId: "repo-id",
  });
  assert.deepEqual(plan.candidates, [{ branch: "feat/merged", action: "remove_worktree_then_delete_branch", worktree: "/feature" }]);
  assert.deepEqual(plan.skipped, [{ branch: "feat/advanced", reason: "no_merged_pull_request" }]);
});

test("skips dirty, locked, current and advanced branches", () => {
  const plan = planCleanup({
    mergedPulls: [
      { headRefName: "feat/dirty", headRefOid: "a", headRepository: { id: "repo-id" } },
      { headRefName: "feat/locked", headRefOid: "b", headRepository: { id: "repo-id" } },
      { headRefName: "feat/current", headRefOid: "c", headRepository: { id: "repo-id" } },
      { headRefName: "feat/advanced", headRefOid: "old", headRepository: { id: "repo-id" } },
    ],
    localBranches: new Map([["feat/dirty", "a"], ["feat/locked", "b"], ["feat/current", "c"], ["feat/advanced", "new"]]),
    worktrees: [
      { path: "/dirty", branch: "feat/dirty", locked: false, isMain: false },
      { path: "/locked", branch: "feat/locked", locked: true, isMain: false },
      { path: "/current", branch: "feat/current", locked: false, isMain: false },
    ],
    cwd: "/current/nested/directory",
    statusForWorktree: (worktree) => worktree === "/dirty" ? " M file" : "",
    defaultBranch: "main",
    repositoryId: "repo-id",
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, [
    { branch: "feat/dirty", reason: "worktree_dirty", worktree: "/dirty" },
    { branch: "feat/locked", reason: "worktree_locked", worktree: "/locked" },
    { branch: "feat/current", reason: "current_worktree", worktree: "/current" },
    { branch: "feat/advanced", reason: "branch_advanced_after_merge" },
  ]);
});

test("skips a merged branch checked out by the main worktree", () => {
  const plan = planCleanup({
    mergedPulls: [{ headRefName: "feat/main-tree", headRefOid: "abc", headRepository: { id: "repo-id" } }],
    localBranches: new Map([["feat/main-tree", "abc"]]),
    worktrees: [{ path: "/repo", branch: "feat/main-tree", locked: false, isMain: true }],
    cwd: "/another-worktree",
    statusForWorktree: () => "",
    defaultBranch: "main",
    repositoryId: "repo-id",
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, [{ branch: "feat/main-tree", reason: "main_worktree", worktree: "/repo" }]);
});

test("does not associate a merged fork PR with an identically named local branch", () => {
  const plan = planCleanup({
    mergedPulls: [{ headRefName: "feat/shared-name", headRefOid: "abc", headRepository: { id: "fork-repo-id" } }],
    localBranches: new Map([["feat/shared-name", "abc"]]),
    worktrees: [],
    cwd: "/repo",
    statusForWorktree: () => "",
    defaultBranch: "main",
    repositoryId: "repo-id",
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, [{ branch: "feat/shared-name", reason: "no_merged_pull_request" }]);
});

test("uses the newest merged PR when an auto-deleted branch name is reused", () => {
  const plan = planCleanup({
    mergedPulls: [
      { headRefName: "feat/reused", headRefOid: "old", mergedAt: "2026-08-09T12:00:00Z", headRepository: { id: "repo-id" } },
      { headRefName: "feat/reused", headRefOid: "new", mergedAt: "2026-08-09T13:00:00Z", headRepository: { id: "repo-id" } },
    ],
    localBranches: new Map([["feat/reused", "new"]]),
    worktrees: [],
    cwd: "/repo",
    statusForWorktree: () => "",
    defaultBranch: "main",
    repositoryId: "repo-id",
  });
  assert.deepEqual(plan.candidates, [{ branch: "feat/reused", action: "delete_branch" }]);
});
