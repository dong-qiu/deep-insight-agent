import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyRange, parseDiff } from "./ci-change-scope.mjs";
import { checkDocuments, anchors } from "./ci-docs-check.mjs";
import { assertRequiredGate } from "./ci-required-gate.mjs";
import { assertPublishAdmission } from "./ci-publish-admission.mjs";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ci-delivery-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "ci@example.test"); git("config", "user.name", "CI test");
  const write = (p, text = "# Title\n\n## Section\n\nText.\n") => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), text); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  write("README.md"); const base = commit();
  return { cwd, git, write, commit, base };
}
function range(f, event = "push") {
  const head = f.git("rev-parse", "HEAD");
  return classifyRange({ cwd: f.cwd, event, base: f.base, head, tested: head });
}

for (const event of ["push", "pull_request"]) {
  test(`${event}: complete code range stays full after last docs-only commit`, () => {
    const f = fixture(); f.write("src/example.ts", "export {};\n"); f.commit(); f.write("docs/verify/receipt.md"); f.commit();
    assert.equal(range(f, event).mode, "full");
  });
  test(`${event}: nested ordinary docs use lightweight path`, () => {
    const f = fixture(); f.write("docs/plan/specs/nested/spec.md"); f.write("docs/verify/receipt.md"); f.commit();
    assert.equal(range(f, event).mode, "docs");
  });
}
for (const path of ["README.md", "skills/L2-workflow.md", ".githooks/pre-push", ".github/workflows/ci.yml", "Dockerfile", "package.json", "package-lock.json", "evals/dataset/sample.json", "src/test.ts", "docs/verify/not-markdown.txt"]) {
  test(`nonallowlisted ${path} is full`, () => { const f = fixture(); f.write(path, "# Changed\n\n## Section\n"); f.commit(); assert.equal(range(f).mode, "full"); });
}
test("renames check old and new paths", () => {
  const f = fixture(); f.write("docs/verify/old.md"); f.commit(); f.base = f.git("rev-parse", "HEAD");
  f.git("mv", "docs/verify/old.md", "docs/verify/new.md"); f.commit();
  assert.equal(range(f).mode, "docs"); assert.equal(range(f).changes[0].paths.length, 2);
  f.git("mv", "docs/verify/new.md", "README-renamed.md"); f.commit(); assert.equal(range(f).mode, "full");
});
test("code to docs rename cannot hide old code", () => {
  const f = fixture(); f.write("src/old.ts"); f.commit(); f.base = f.git("rev-parse", "HEAD");
  f.write("docs/verify/dummy.md"); f.git("mv", "src/old.ts", "docs/verify/new.md"); f.commit(); assert.equal(range(f).mode, "full");
});
test("symlink and executable docs are full", () => {
  const f = fixture(); f.write("docs/verify/plain.md"); symlinkSync("plain.md", join(f.cwd, "docs/verify/link.md")); f.commit();
  assert.equal(range(f).mode, "full");
  const g = fixture(); g.write("docs/verify/exec.md"); g.git("add", "."); g.git("update-index", "--chmod=+x", "docs/verify/exec.md"); g.git("commit", "-qm", "exec"); assert.equal(range(g).mode, "full");
});
test("deletion is docs; inbound dangling link is rejected", () => {
  const f = fixture(); f.write("docs/verify/old.md"); f.write("README.md", "# Title\n\n[receipt](docs/verify/old.md)\n"); f.commit(); f.base = f.git("rev-parse", "HEAD");
  f.git("rm", "docs/verify/old.md"); f.commit(); const scope = range(f); assert.equal(scope.mode, "docs"); assert.throws(() => checkDocuments(f.cwd, scope), /broken link/);
});
for (const tweak of [{ base: "0".repeat(40) }, { base: "bad" }, { head: "f".repeat(40) }, { event: "workflow_dispatch" }]) {
  test(`invalid range fallback ${JSON.stringify(tweak)}`, () => {
    const f = fixture(); f.write("docs/verify/a.md"); const head = f.commit();
    assert.equal(classifyRange({ cwd: f.cwd, event: "push", base: f.base, head, tested: head, ...tweak }).mode, "full");
  });
}
test("empty, reversed, tested mismatch and divergent ranges are full", () => {
  const f = fixture(); f.write("docs/verify/a.md"); const head = f.commit();
  for (const o of [{ base: head }, { base: head, head: f.base }, { tested: f.base }]) assert.equal(classifyRange({ cwd: f.cwd, event: "push", base: f.base, head, tested: head, ...o }).mode, "full");
  f.git("checkout", "-qb", "divergent", f.base); f.write("src/code.ts"); const other = f.commit();
  assert.equal(classifyRange({ cwd: f.cwd, event: "pull_request", base: other, head, tested: other }).mode, "full");
});
test("PR merge ref must test exactly the candidate tree", () => {
  const f = fixture(); f.write("docs/verify/a.md"); const head = f.commit();
  const tree = f.git("rev-parse", "HEAD^{tree}");
  const tested = f.git("commit-tree", tree, "-p", f.base, "-p", head, "-m", "test merge");
  assert.equal(classifyRange({ cwd: f.cwd, event: "pull_request", base: f.base, head, tested }).mode, "docs");
  f.write("src/code.ts"); const changed = f.commit();
  assert.equal(classifyRange({ cwd: f.cwd, event: "pull_request", base: f.base, head, tested: changed }).mode, "full");
});
test("file type replacement is full", () => {
  const f = fixture(); f.write("docs/verify/a.md"); f.commit(); f.base = f.git("rev-parse", "HEAD");
  f.git("rm", "docs/verify/a.md"); mkdirSync(join(f.cwd, "docs/verify"), { recursive: true }); symlinkSync("../../README.md", join(f.cwd, "docs/verify/a.md")); f.commit(); assert.equal(range(f).mode, "full");
});
test("malformed/unknown/truncated raw diff is rejected", () => {
  for (const s of ["broken", "broken\0", `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} X\0a\0`, `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100\0a\0`]) assert.throws(() => parseDiff(s));
});
test("docs checker checks links, anchors, formatting and receipt sections", () => {
  const f = fixture(); f.write("docs/verify/receipt.md", "# Receipt\n\n## Section\n\n[spec](../plan/specs/spec.md#acceptance)\n"); f.write("docs/plan/specs/spec.md", "# Spec\n\n## Acceptance\n\nOK.\n"); f.commit();
  const scope = range(f); assert.equal(checkDocuments(f.cwd, scope), 2);
  for (const text of ["# Title\n\n[bad](missing.md)\n", "# Title\n\n## Section\n\n[bad](../plan/specs/spec.md#absent)\n", "# Title \n\n## Section\n", "# Title\n\n## Section\n\n```\nbroken\n", "# Title\n\n## Section\n\n[bad][missing]\n"]) {
    f.write("docs/verify/receipt.md", text); assert.throws(() => checkDocuments(f.cwd, scope));
  }
  assert.deepEqual([...anchors("# 标题\n\n## Repeat\n\n## Repeat\n\n## `Code` name\n")], ["标题", "repeat", "repeat-1", "code-name"]);
});
test("delivery receipt requires five explicit sections", () => {
  const f = fixture(); f.write("docs/verify/pr-delivery-efficiency-1-2026-10-04.md"); f.commit(); assert.throws(() => checkDocuments(f.cwd, range(f)), /receipt missing/);
});
test("angle reference links pass, but target deletion rejects unchanged inbound links", () => {
  const f = fixture();
  f.write("README.md", "# Title\n\n[Receipt][r]\n\n[r]: <docs/verify/target.md#section>\n"); f.base = f.commit();
  f.write("docs/verify/target.md");
  f.write("docs/verify/ref.md", "# Receipt\n\n## Section\n\n[Target][t]\n\n[t]: <target.md>\n"); f.commit();
  assert.equal(checkDocuments(f.cwd, range(f)), 2);
  f.base = f.git("rev-parse", "HEAD"); f.git("rm", "docs/verify/target.md"); f.commit();
  assert.throws(() => checkDocuments(f.cwd, range(f)), /broken link/);
  f.write("docs/verify/target.md"); f.base = f.commit(); f.git("mv", "docs/verify/target.md", "docs/verify/renamed.md"); f.commit();
  assert.throws(() => checkDocuments(f.cwd, range(f)), /broken link/);
});
test("Setext, slug collisions and code-example HTML anchors follow visible headings", () => {
  assert.deepEqual([...anchors("Title\n=====\n\nSection\n-------\n\n## Foo\n\n## Foo\n\n## Foo-1\n")], ["title", "section", "foo", "foo-1", "foo-1-1"]);
  const f = fixture(); f.write("docs/verify/target.md", "# Title\n\n## Existing\n\n```html\n<a id=\"removed\">Example</a>\n```\n");
  f.write("docs/verify/link.md", "# Link\n\n## Section\n\n[broken](target.md#removed)\n"); f.commit();
  assert.throws(() => checkDocuments(f.cwd, range(f)), /broken anchor/);
  assert.ok(!anchors('`<a id="inline-code">`\n').has("inline-code"));
  assert.ok(!anchors('# Title\n\n``<a id="double-code">`literal`</a>``\n').has("double-code"));
  assert.ok(!anchors('# Title\n\n    <a id="indented-code"></a>\n').has("indented-code"));
  assert.ok(anchors('# Title\n\n- item\n\n    <a id="list-anchor"></a>\n').has("list-anchor"));
  f.write("docs/verify/target.md", '# Title\n\n## Existing\n\n``<a id="removed">`literal`</a>``\n\n    <a id="removed"></a>\n');
  assert.throws(() => checkDocuments(f.cwd, range(f)), /broken anchor/);
});
test("required gates accept only selected success and opposite skipped", () => {
  for (const mode of ["docs", "full"]) {
    const ok = { mode, scope: "success", docs: mode === "docs" ? "success" : "skipped", full: mode === "full" ? "success" : "skipped" };
    assert.doesNotThrow(() => assertRequiredGate(ok));
    for (const field of ["scope", mode]) for (const result of ["failure", "cancelled", "skipped", "", "unknown"]) assert.throws(() => assertRequiredGate({ ...ok, [field]: result }));
    assert.throws(() => assertRequiredGate({ ...ok, [mode === "docs" ? "full" : "docs"]: "success" }));
  }
  assert.throws(() => assertRequiredGate({ mode: "unknown", scope: "success", docs: "success", full: "success" }));
});

function publication(mode) {
  const f = fixture(); f.write(mode === "docs" ? "docs/verify/receipt.md" : "src/test.ts"); const head = f.commit();
  const repo = { full_name: "owner/repo", id: 1 };
  const run = { id: 123, run_attempt: 1, head_sha: head, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", repository: repo, head_repository: repo, status: "completed", conclusion: "success" };
  const scope = { ...range(f), schema_version: "ci-change-scope-v1", repository: "owner/repo", event: "push", base: f.base, head, tested_commit: head, run: { id: "123", attempt: 1 } };
  const jobs = ["classify change scope", "typecheck · test · build", "docker build", "eval-gate (trailer)", "documentation checks", "full application verification", "full Docker verification"].map(name => ({ name, head_sha: head, run_attempt: 1, status: "completed", conclusion: name === "documentation checks" ? (mode === "docs" ? "success" : "skipped") : name.startsWith("full ") ? (mode === "full" ? "success" : "skipped") : "success" }));
  const evidence = (schema, keys) => ({ schema_version: schema, commit: head, tested_commit: head, run: scope.run, checks: Object.fromEntries(keys.map(k => [k, "pass"])) });
  return { cwd: f.cwd, run, event: structuredClone(run), repository: "owner/repo", scope, jobs, ci: evidence("prototype-ci-evidence-v1", ["lint", "test", "typecheck", "build"]), docker: evidence("prototype-docker-evidence-v1", ["docker"]) };
}
test("publication admits only full trusted main; docs never publishes", () => {
  assert.equal(assertPublishAdmission(publication("full")), true);
  const docs = publication("docs"); delete docs.ci; delete docs.docker; assert.equal(assertPublishAdmission(docs), false);
});
test("publication rejects every failed, cancelled or unexpected skipped required job", () => {
  for (const mode of ["full", "docs"]) {
    const p = publication(mode);
    for (const job of p.jobs.filter(j => j.conclusion === "success")) for (const result of ["failure", "cancelled", "skipped"]) {
      const bad = structuredClone(p); bad.jobs.find(j => j.name === job.name).conclusion = result;
      assert.throws(() => assertPublishAdmission(bad));
    }
  }
});
test("publication rejects untrusted source, SHA/attempt mismatch and missing evidence", () => {
  const p = publication("full");
  const mutations = [
    x => { x.run.event = "pull_request"; }, x => { x.run.head_branch = "feature"; }, x => { x.run.path = ".github/workflows/other.yml"; },
    x => { x.run.head_repository = { full_name: "fork/repo", id: 2 }; }, x => { x.run.conclusion = "failure"; },
    x => { x.event.head_sha = "a".repeat(40); }, x => { x.event.run_attempt = 2; }, x => { x.scope.run.attempt = 2; },
    x => { x.scope.tested_commit = "a".repeat(40); }, x => { x.scope.mode = "docs"; }, x => { x.scope.changes = []; },
    x => { x.jobs.pop(); }, x => { x.jobs.push(x.jobs[0]); }, x => { x.jobs[0].head_sha = "a".repeat(40); },
    x => { x.ci = undefined; }, x => { x.docker = undefined; }, x => { x.ci.run.attempt = 2; },
    x => { x.docker.tested_commit = "a".repeat(40); }, x => { x.ci.checks.build = "fail"; }
  ];
  for (const mutate of mutations) { const bad = structuredClone(p); mutate(bad); assert.throws(() => assertPublishAdmission(bad)); }
});
test("actual scope/docs/gate CLIs execute without npm dependencies", () => {
  const f = fixture(); f.write("docs/verify/receipt.md"); const head = f.commit();
  const payload = join(f.cwd, "event.json"), output = join(f.cwd, "scope.json");
  writeFileSync(payload, JSON.stringify({ repository: { full_name: "owner/repo" }, before: f.base, after: head }));
  const env = { ...process.env, GITHUB_EVENT_PATH: payload, GITHUB_EVENT_NAME: "push", GITHUB_SHA: head, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: join(f.cwd, "outputs") };
  const cli = name => fileURL(name);
  assert.equal(spawnSync(process.execPath, [cli("ci-change-scope.mjs"), output], { cwd: f.cwd, env }).status, 0);
  assert.equal(JSON.parse(readFileSync(output)).mode, "docs");
  assert.equal(spawnSync(process.execPath, [cli("ci-docs-check.mjs"), output], { cwd: f.cwd, env }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli("ci-required-gate.mjs")], { cwd: f.cwd, env: { ...env, MODE: "docs", SCOPE_RESULT: "success", DOCS_RESULT: "failure", FULL_RESULT: "skipped" } }).status, 1);
});
function fileURL(name) { return new URL(name, import.meta.url).pathname; }

for (const mode of ["docs", "full"]) {
  test(`actual publication CLI ${mode} and missing-artifact failure`, () => {
    const p = publication(mode), dir = join(p.cwd, "artifacts");
    for (const [folder, file, value] of [["scope", "ci-change-scope.json", p.scope], ["ci", "prototype-ci-evidence.json", p.ci], ["docker", "prototype-docker-evidence.json", p.docker]]) {
      mkdirSync(join(dir, folder), { recursive: true }); writeFileSync(join(dir, folder, file), JSON.stringify(value));
    }
    const metadata = join(p.cwd, "metadata.json"); writeFileSync(metadata, JSON.stringify(p));
    const output = join(p.cwd, "output");
    const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(p.cwd, "summary") };
    const cli = () => spawnSync(process.execPath, [fileURL("ci-publish-admission.mjs"), dir, metadata], { cwd: p.cwd, env });
    assert.equal(cli().status, 0); assert.equal(readFileSync(output, "utf8"), `publish=${mode === "full"}\n`);
    writeFileSync(join(dir, "scope/ci-change-scope.json"), "{}"); assert.equal(cli().status, 1);
  });
}

test("workflow topology preserves required entries, evidence and serial Docker before PR 3", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const publish = readFileSync(new URL("../.github/workflows/publish-image.yml", import.meta.url), "utf8");
  for (const name of ["typecheck · test · build", "docker build", "eval-gate (trailer)"]) assert.ok(ci.includes(`name: ${name}`));
  for (const key of ["verify", "docker"]) {
    const block = ci.match(new RegExp(`\\n  ${key}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:|$)`))[1];
    assert.ok(block.includes("if: always()")); assert.ok(block.includes("ci-required-gate.mjs"));
  }
  assert.ok(ci.includes("needs: [scope, application]"));
  assert.ok(ci.includes("npm run build:e2e")); assert.ok(ci.includes("npm run test:e2e:built"));
  assert.ok(!ci.includes("paths-ignore"));
  assert.ok(publish.includes("needs: admission")); assert.ok(publish.includes("if: needs.admission.outputs.publish == 'true'"));
  assert.ok(!publish.slice(0, publish.indexOf("\n  publish:")).includes("packages: write"));
});
