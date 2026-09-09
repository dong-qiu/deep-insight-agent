import type { TechLeadKind } from "../types.js";

/** A pure classifier shared by agent derivation and DB-side planning reads. Keeping it below the
 * agent layer prevents maintenance-only DB startup from importing report generation or an LLM SDK. */
export function classifyTechLead(text: string, tags: string[]): TechLeadKind {
  const value = `${text} ${tags.join(" ")}`.toLowerCase();
  if (/\b(arxiv|paper)\b|论文|研究/.test(value)) return "paper";
  if (/\b(benchmark|eval|swe-bench)\b|基准|评测/.test(value)) return "benchmark";
  if (/\b(security|vulnerability|attack|cve)\b|安全|漏洞|攻击/.test(value)) return "security";
  if (/\b(framework|sdk|mcp|library)\b|框架|协议/.test(value)) return "framework";
  if (/\b(model|llm|claude|gpt|gemini)\b|模型/.test(value)) return "model";
  if (/\b(tool|agent|ide|copilot|cursor)\b|工具|代理/.test(value)) return "tool";
  if (/\b(method|workflow|practice)\b|方法|实践/.test(value)) return "method";
  return "other";
}
