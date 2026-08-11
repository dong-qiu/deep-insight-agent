/**
 * Resolve the commit range that Eval-Gate must inspect in CI.
 *
 * A squash merge creates a new main commit, so `before..after` no longer
 * includes the reviewed PR commits (and their Eval-Gate trailer).  GitHub can
 * associate that merge commit with its PR; inspect the original PR range in
 * that case. Direct pushes retain the existing fail-closed range.
 */

const SHA_RE = /^[0-9a-f]{40}$/i;

function requiredSha(value, name) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new Error(`invalid ${name} SHA`);
  }
  return value;
}

function optionalPullNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function associatedMergedPullRequest(pulls, pushAfter) {
  return pulls.find((pull) => (
    pull?.state === "closed"
    && pull.merged_at
    && pull.merge_commit_sha === pushAfter
    && optionalPullNumber(pull.number)
    && SHA_RE.test(pull.base?.sha ?? "")
    && SHA_RE.test(pull.head?.sha ?? "")
  )) ?? null;
}

export function resolveEvalGateRange({ event, prBase, prHead, prNumber, pushBefore, pushAfter, pulls = [] }) {
  if (event === "pull_request") {
    return {
      baseSha: requiredSha(prBase, "PR base"),
      headSha: requiredSha(prHead, "PR head"),
      pullNumber: optionalPullNumber(prNumber),
      source: "pull_request",
    };
  }

  if (event !== "push") throw new Error(`unsupported event: ${event}`);

  const after = requiredSha(pushAfter, "push after");
  const mergedPull = associatedMergedPullRequest(pulls, after);
  if (mergedPull) {
    return {
      baseSha: requiredSha(mergedPull.base.sha, "merged PR base"),
      headSha: requiredSha(mergedPull.head.sha, "merged PR head"),
      pullNumber: mergedPull.number,
      source: "merged_pull_request",
    };
  }

  return {
    baseSha: requiredSha(pushBefore, "push before"),
    headSha: after,
    pullNumber: null,
    source: "direct_push",
  };
}

async function pullsForCommit({ repository, token, pushAfter }) {
  if (!repository || !token) return [];
  const response = await fetch(
    `https://api.github.com/repos/${repository}/commits/${pushAfter}/pulls?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub commit/PR lookup failed: HTTP ${response.status}`);
  return response.json();
}

export async function resolveFromEnvironment(env) {
  const event = env.EVENT;
  let pulls = [];
  if (event === "push") {
    try {
      pulls = await pullsForCommit({
        repository: env.GITHUB_REPOSITORY,
        token: env.GITHUB_TOKEN,
        pushAfter: env.PUSH_AFTER,
      });
    } catch (error) {
      // Fallback is intentionally the existing direct-push check: it may
      // reject an unresolvable squash merge, but never grants a false pass.
      console.warn(`eval-gate: unable to resolve an associated PR; using direct push range (${error.message}).`);
    }
  }
  return resolveEvalGateRange({
    event,
    prBase: env.PR_BASE,
    prHead: env.PR_HEAD,
    prNumber: Number(env.PR_NUMBER),
    pushBefore: env.PUSH_BEFORE,
    pushAfter: env.PUSH_AFTER,
    pulls,
  });
}

async function main() {
  const range = await resolveFromEnvironment(process.env);
  process.stdout.write(`${JSON.stringify(range)}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(`eval-gate: ${error.message}`);
    process.exitCode = 1;
  });
}
