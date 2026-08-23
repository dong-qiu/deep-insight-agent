/** PR 政策门：以最终 PR diff 判断 AI 高风险面，并核验可审计的审查/评测证据。
 *
 * 初版由 CI 运行但尚未列入 main 的必需检查；先观察误报，再升级为阻断门。
 * 不运行模型评测，也不替代 eval-gate：它只检查 PR 是否交代了已运行的证据。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const AI_RISK_RE = /^(?:src\/lib\/agents\/|src\/lib\/sources\/|src\/lib\/runtime\/llm\.ts$|evals\/dataset\/)/;
const TEST_RE = /\.test\.[cm]?[jt]sx?$/;

export function aiRiskFiles(files) {
  return files.filter((file) => AI_RISK_RE.test(file) && !TEST_RE.test(file));
}

function withoutComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

function hasPrePrReview(markdown) {
  return (
    /^##\s+Pre-PR AI Review\s*$/mi.test(markdown) &&
    /^-[ \t]*基线：[ \t]*\S[^\r\n]*$/m.test(markdown) &&
    /^-[ \t]*范围：[ \t]*\S[^\r\n]*$/m.test(markdown) &&
    /^-[ \t]*风险级别：[ \t]*(?:低|中|高)[ \t]*$/m.test(markdown) &&
    /^-[ \t]*结论：[ \t]*(?:通过|需修复|待确认)[^\r\n]*$/m.test(markdown) &&
    /^Blocking:[ \t]*\d+;[ \t]*Warning:[ \t]*\d+$/m.test(markdown)
  );
}

function hasMetricTable(markdown) {
  const lines = markdown.split("\n");
  const header = lines.findIndex((line) => /^\|\s*指标\s*\|\s*基线\s*\|\s*本次\s*\|\s*变化\s*\|\s*阈值\s*\/\s*结论\s*\|\s*$/.test(line));
  if (header < 0) return false;

  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length >= 5 && cells.slice(0, 5).every(Boolean)) return true;
  }
  return false;
}

function hasNamedEvidence(markdown, label) {
  return new RegExp(`^${label}：[ \\t]*\\S[^\\r\\n]*$`, "m").test(markdown);
}

export function evaluatePolicy({ changedFiles, prBody, hasEvalGateException = false }) {
  const riskFiles = aiRiskFiles(changedFiles);
  if (!riskFiles.length) return { ok: true, riskFiles, reasons: [] };

  const body = withoutComments(prBody ?? "");
  const reasons = [];
  if (!hasPrePrReview(body)) {
    reasons.push("缺少完整的 `## Pre-PR AI Review` 摘要（基线、范围、风险级别、结论、`Blocking: N; Warning: N`）。");
  }

  const hasMetricsAndArtifact = hasMetricTable(body) && hasNamedEvidence(body, "评测产物");
  const hasDocumentedException = hasEvalGateException && hasNamedEvidence(body, "评测例外");
  if (!hasMetricsAndArtifact && !hasDocumentedException) {
    reasons.push("缺少已填指标表和“评测产物”，或带 Eval-Gate scoped/skip trailer 的“评测例外”。");
  }

  return { ok: reasons.length === 0, riskFiles, reasons };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function gitText(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
  const args = process.argv.slice(2);
  const base = argValue(args, "--base");
  const head = argValue(args, "--head");
  const bodyFile = argValue(args, "--pr-body-file");
  if (!base || !head || !bodyFile) {
    console.error("用法: node ops/pr-policy.mjs --base <sha> --head <sha> --pr-body-file <path>");
    process.exitCode = 2;
    return;
  }

  const changedFiles = gitText(["diff", "--name-only", `${base}...${head}`]).trim().split("\n").filter(Boolean);
  const commitMessages = gitText(["log", "--format=%B", `${base}..${head}`]);
  const result = evaluatePolicy({
    changedFiles,
    prBody: readFileSync(bodyFile, "utf8"),
    hasEvalGateException: /^[ \t]*Eval-Gate:\s*(?:scoped|skip)\b/im.test(commitMessages),
  });

  if (!result.riskFiles.length) {
    console.log("pr-policy: 未命中 AI 高风险路径。");
    return;
  }
  console.log(`pr-policy: AI 高风险文件：${result.riskFiles.join(", ")}`);
  if (result.ok) {
    console.log("pr-policy: 审查与评测证据完整。");
    return;
  }
  console.error("pr-policy: 证据不完整：");
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
