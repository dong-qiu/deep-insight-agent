import { describe, expect, it } from "vitest";
import { aiRiskFiles, evaluatePolicy } from "./pr-policy.mjs";

const completeReview = `## Pre-PR AI Review

- 基线：\`origin/main\` @ \`abc123\`
- 范围：\`src/lib/agents/analyzer.ts\`
- 风险级别：高
- 结论：通过

### PR 交接
Blocking：0；Warning：0（已处理）。`;

const metricEvidence = `| 指标 | 基线 | 本次 | 变化 | 阈值 / 结论 |
|---|---:|---:|---:|---|
| 引用可验证率 | 96.0% | 97.0% | +1.0pp | 通过 |

评测产物：[A1 结果](https://example.test/a1)`;

describe("pr-policy", () => {
  it("只将非测试的 AI 质量面识别为高风险", () => {
    expect(aiRiskFiles([
      "src/lib/agents/analyzer.ts",
      "src/lib/agents/analyzer.test.ts",
      "src/lib/sources/rss.ts",
      "src/lib/runtime/llm.ts",
      "evals/dataset/quality.jsonl",
      "README.md",
    ])).toEqual([
      "src/lib/agents/analyzer.ts",
      "src/lib/sources/rss.ts",
      "src/lib/runtime/llm.ts",
      "evals/dataset/quality.jsonl",
    ]);
  });

  it("非高风险 PR 不要求 AI 证据", () => {
    expect(evaluatePolicy({ changedFiles: ["README.md"], prBody: "" })).toMatchObject({ ok: true, riskFiles: [] });
  });

  it("高风险 PR 同时有审查摘要、指标表和产物才通过", () => {
    expect(evaluatePolicy({
      changedFiles: ["src/lib/agents/analyzer.ts"],
      prBody: `${completeReview}\n\n${metricEvidence}`,
    })).toMatchObject({ ok: true, reasons: [] });
  });

  it("模板中的空指标行和注释不被当作评测证据", () => {
    const result = evaluatePolicy({
      changedFiles: ["src/lib/sources/rss.ts"],
      prBody: `${completeReview}\n\n| 指标 | 基线 | 本次 | 变化 | 阈值 / 结论 |\n|---|---:|---:|---:|---|\n| <!-- 指标 --> |  |  |  |  |\n\n评测产物：<!-- 链接 -->`,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(1);
  });

  it("缺少范围或风险级别的审查摘要不通过", () => {
    const withoutScope = completeReview.replace("- 范围：`src/lib/agents/analyzer.ts`\n", "");
    const withoutRisk = completeReview.replace("- 风险级别：高\n", "");
    for (const prBody of [withoutScope, withoutRisk]) {
      expect(evaluatePolicy({
        changedFiles: ["src/lib/agents/analyzer.ts"],
        prBody: `${prBody}\n\n${metricEvidence}`,
      }).ok).toBe(false);
    }
  });

  it("必填字段留空时不跨行借用下一字段", () => {
    const emptyBaseline = completeReview.replace("- 基线：`origin/main` @ `abc123`", "- 基线：");
    const emptyScope = completeReview.replace("- 范围：`src/lib/agents/analyzer.ts`", "- 范围：");
    const emptyRisk = completeReview.replace("- 风险级别：高", "- 风险级别：");
    for (const prBody of [emptyBaseline, emptyScope, emptyRisk]) {
      expect(evaluatePolicy({
        changedFiles: ["src/lib/agents/analyzer.ts"],
        prBody: `${prBody}\n\n${metricEvidence}`,
      }).ok).toBe(false);
    }
  });

  it("有 scoped/skip trailer 时，允许带明确说明的评测例外", () => {
    expect(evaluatePolicy({
      changedFiles: ["src/lib/agents/report-gen.ts"],
      prBody: `${completeReview}\n\n评测例外：确定性渲染改动，已运行 report-gen 集成测试。`,
      hasEvalGateException: true,
    })).toMatchObject({ ok: true, reasons: [] });
  });
});
