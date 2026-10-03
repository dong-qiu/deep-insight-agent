import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const doc = /^docs\/(?:verify|plan\/specs)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Parse raw -z records, including BOTH paths of a rename. Never use an API file list. */
export function parseDiff(raw) {
  const fields = raw.split("\0");
  if (fields.pop() !== "") throw new Error("unterminated Git diff");
  const changes = [];
  while (fields.length) {
    const header = fields.shift();
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDTRC][0-9]*)$/.exec(header);
    if (!match) throw new Error("unknown Git diff record");
    const [, oldMode, newMode, , , status] = match;
    const paths = [fields.shift()];
    if (/^[RC]/.test(status)) paths.push(fields.shift());
    if (paths.some(p => !p || p.includes("\n") || p.includes("\r"))) throw new Error("invalid Git path");
    changes.push({ oldMode, newMode, status, paths });
  }
  return changes;
}

export function classifyRange({ cwd = process.cwd(), event, base, head, tested }) {
  try {
    if (!["pull_request", "push"].includes(event) || ![base, head, tested].every(s => sha.test(s) && !/^0+$/.test(s)) || base === head) throw new Error("invalid event/range");
    for (const s of [base, head, tested]) git(cwd, ["cat-file", "-e", `${s}^{commit}`]);
    // Strict branch protection supplies an up-to-date PR base. Divergence or force push is full.
    git(cwd, ["merge-base", "--is-ancestor", base, head]);
    if (event === "push" && tested !== head) throw new Error("push tested SHA differs");
    if (event === "pull_request") {
      git(cwd, ["merge-base", "--is-ancestor", head, tested]);
      // The tested merge ref may include current base changes: do not hide them.
      if (git(cwd, ["rev-parse", `${head}^{tree}`]).trim() !== git(cwd, ["rev-parse", `${tested}^{tree}`]).trim()) throw new Error("PR tested tree differs from candidate");
    }
    const changes = parseDiff(git(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--find-renames", base, head, "--"]));
    if (!changes.length) throw new Error("empty range");
    const docs = changes.every(c => /^[AMD]$|^R\d+$/.test(c.status) &&
      [c.oldMode, c.newMode].every(m => ["000000", "100644"].includes(m)) && c.paths.every(p => doc.test(p)));
    return { mode: docs ? "docs" : "full", reason: docs ? "ordinary documentation only" : "code, mixed or nonordinary paths", changes };
  } catch (error) {
    return { mode: "full", reason: `conservative fallback: ${error.message}`, changes: [] };
  }
}

export function scopeFromEvent(payload, event, tested, cwd) {
  const base = event === "pull_request" ? payload.pull_request?.base?.sha : payload.before;
  const head = event === "pull_request" ? payload.pull_request?.head?.sha : payload.after;
  return { schema_version: "ci-change-scope-v1", repository: payload.repository?.full_name,
    event, base, head, tested_commit: tested,
    run: { id: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    ...classifyRange({ cwd, event, base, head, tested }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = scopeFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), process.env.GITHUB_EVENT_NAME, process.env.GITHUB_SHA);
  writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${evidence.mode}\n`);
  console.log(`CI scope: ${evidence.mode}; ${evidence.reason}`);
}
