/** PPT 生成（A 阶段：确定性骨架，无 LLM）。
 *  输入 = 已经过 `report-gen.selectInsights` 白名单的 IncludedInsight[]（pass/flagged）+
 *  topic + source 名查找；输出 = .pptx Buffer + 页数。
 *
 *  极简模板：白底 / 单色暗灰文 / Microsoft YaHei（CJK 兼容）/ 13.33×7.5 宽屏。
 *  幻灯片骨架：
 *    1. 标题页（topic 名 + 报告标题 + 计数 + 生成日）
 *    2..K+1. 重点（importance≥4）一条一页（statement + 1-2 条 verbatim quote + 源名）
 *    K+2..K+P+1. 其他动态（importance<4，每页 4 条聚合表）
 *    K+P+2. 源与方法（源列表 + 时间窗 + 生成日）
 *    空报告时退化为标题页 + "本期无重要事件" 一页。
 *
 *  v1 不调 LLM；slide 标题用 statement 截断（B 阶段会换成 LLM 凝练标题 + summary 页）。 */
import PptxGenJsImport from "pptxgenjs";
import type { Insight, Report, Topic } from "../types.js";
import { flagLabel } from "../utils/citation-verdict.js";
import type { ExecutivePolish, InsightPolish } from "./ppt-polish.js";

// pptxgenjs CJS/ESM 互操作不稳定：tsx 直接跑 ESM 路径返 { default } 而 vitest 走 CJS
// 路径直接返 class。此处兼容两种形态——确保任意 runtime 下 `new PptxGen()` 都成立。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PptxGen: typeof PptxGenJsImport =
  (PptxGenJsImport as unknown as { default?: typeof PptxGenJsImport }).default ?? PptxGenJsImport;

export interface IncludedInsightLite {
  insight: Insight;
  citationIndices: number[]; // 已剔除 blocked、含 flagged
  flaggedUncertain: boolean; // genuine uncertain →「待核实」
  flaggedError: boolean; // 一致性校验失败 →「校验失败·待重试」（见 report-gen.flagLabel）
}

export interface PptGenInput {
  report: Report;
  insights: IncludedInsightLite[];
  topic: Topic;
  /** content_item_id → 源名（来自 source.name），用作 quote 后缀。缺失时回退 ci 代码。 */
  sourceNameByCi: Map<string, string>;
  /** source_id → 源名，用作末尾"源与方法"页列表（去重）。 */
  sourceNameById?: Map<string, string>;
  /** B 阶段 LLM 润色（可选）。存在时：插入 Executive 页 + 重点条用 polish 覆盖 §1/§3；
   *  缺失时退化 A 阶段确定性 fallback（statement 首句 / importance_basis）。 */
  polish?: {
    perInsight: Map<string, InsightPolish>;
    executive: ExecutivePolish | null;
  };
}

export interface PptGenOutput {
  buffer: Buffer;
  pageCount: number;
}

const STYLE = {
  bgColor: "FFFFFF",
  textPrimary: "1F2937", // 暗灰（不刺眼的黑）
  textSubtle: "374151",
  textMuted: "6B7280",
  accent: "111827",
  flagAccent: "B45309", // 待核实标签（与报告 HTML 同色）
  fontFace: "Microsoft YaHei", // CJK 兼容；客户端缺该字体时 PowerPoint 自动 fallback
};

const KEY_IMPORTANCE = 4;
const OTHER_PER_SLIDE = 4;

export async function buildPptx(input: PptGenInput): Promise<PptGenOutput> {
  const pres = new PptxGen();
  pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 inch

  let pages = 0;
  addTitleSlide(pres, input);
  pages += 1;

  if (input.insights.length === 0) {
    addEmptySlide(pres);
    pages += 1;
    return finish(pres, pages);
  }

  const key = input.insights.filter((x) => x.insight.importance >= KEY_IMPORTANCE);
  const rest = input.insights.filter((x) => x.insight.importance < KEY_IMPORTANCE);

  // B 阶段：标题页后插 Executive Summary（仅 polish.executive 存在时）
  if (input.polish?.executive) {
    addExecutiveSlide(pres, input.polish.executive, input);
    pages += 1;
  }

  for (let i = 0; i < key.length; i++) {
    addKeyInsightSlide(pres, key[i], i + 1, input);
    pages += 1;
  }

  if (rest.length > 0) {
    pages += addOtherInsightSlides(pres, rest);
  }

  addSourcesSlide(pres, input);
  pages += 1;

  return finish(pres, pages);
}

async function finish(pres: InstanceType<typeof PptxGen>, pageCount: number): Promise<PptGenOutput> {
  // pptxgenjs 的 write 返回 Promise<string | ArrayBuffer | Buffer | Blob>；nodebuffer → Buffer
  const buf = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return { buffer: buf, pageCount };
}

function addTitleSlide(pres: InstanceType<typeof PptxGen>, input: PptGenInput): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  s.addText(input.topic.name, {
    x: 0.5, y: 2.5, w: 12.3, h: 1.2,
    fontSize: 36, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
  });
  s.addText(input.report.title.replace(`${input.topic.name} · `, ""), {
    x: 0.5, y: 3.7, w: 12.3, h: 0.6,
    fontSize: 18, fontFace: STYLE.fontFace, color: STYLE.textSubtle,
  });
  const meta = `${input.insights.length} 条洞察 · 生成于 ${input.report.generated_at.slice(0, 10)}`;
  s.addText(meta, {
    x: 0.5, y: 4.4, w: 12.3, h: 0.4,
    fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textMuted,
  });
  s.addText("Insight Agent · 自动生成 · 可编辑", {
    x: 0.5, y: 6.9, w: 12.3, h: 0.3,
    fontSize: 9, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true,
  });
}

function addExecutiveSlide(
  pres: InstanceType<typeof PptxGen>,
  exec: ExecutivePolish,
  input: PptGenInput,
): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  s.addText("Executive Summary", {
    x: 0.5, y: 0.4, w: 12.3, h: 0.5,
    fontSize: 13, fontFace: STYLE.fontFace, color: STYLE.textMuted,
  });
  s.addText("本期要点总览", {
    x: 0.5, y: 0.85, w: 12.3, h: 0.7,
    fontSize: 26, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
  });
  const lines = exec.takeaways.map((t) => ({
    text: `· ${t}`,
    options: { breakLine: true, fontSize: 14, color: STYLE.textSubtle },
  }));
  s.addText(lines, {
    x: 0.5, y: 1.9, w: 12.3, h: 4.6,
    fontFace: STYLE.fontFace, valign: "top", paraSpaceAfter: 8,
  });
  s.addText(
    `${input.topic.name} · ${input.report.generated_at.slice(0, 10)} · LLM 凝练（基于 ${input.polish?.perInsight.size ?? 0} 条已校验重点）`,
    {
      x: 0.5, y: 6.95, w: 12.3, h: 0.25,
      fontSize: 9, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true, align: "right",
    },
  );
}

function addEmptySlide(pres: InstanceType<typeof PptxGen>): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  s.addText("本期无重要事件", {
    x: 0.5, y: 3.2, w: 12.3, h: 1, align: "center",
    fontSize: 28, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true,
  });
}

/** 重点条单页：3 段结构（简要总结 / 主要内容 / 对我们的启示）。
 *  A 阶段确定性填充——§1 截 statement 首句；§2 完整 statement + 1-2 verbatim quote；
 *  §3 用 analyzer 标的 importance_basis 作 honest proxy（"为什么重要"），尾部小字提示
 *  "B 阶段 LLM 将基于主题上下文重写为可行启示"。 */
function addKeyInsightSlide(
  pres: InstanceType<typeof PptxGen>,
  x: IncludedInsightLite,
  n: number,
  input: PptGenInput,
): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  const date = input.report.generated_at.slice(0, 10);

  // ── 顶部编号 + 标签 ──
  const label = flagLabel(x);
  const tag = label || `重点 · 重要性 ${x.insight.importance}/5`;
  s.addText(`#${n}  ·  ${tag}`, {
    x: 0.5, y: 0.3, w: 12.3, h: 0.3,
    fontSize: 10, fontFace: STYLE.fontFace,
    color: label ? STYLE.flagAccent : STYLE.textMuted,
  });

  // ── 标题（pithy；A 阶段截断、B 阶段 LLM 凝练）──
  s.addText(briefTitle(x.insight.statement), {
    x: 0.5, y: 0.65, w: 12.3, h: 0.85,
    fontSize: 22, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
    valign: "top",
  });

  // ── §1 简要总结（B：LLM 凝练；A fallback：statement 首句）──
  sectionHeader(s, "简要总结", 1.6);
  const polish = input.polish?.perInsight.get(x.insight.id);
  const summaryText = polish?.brief_summary ?? briefSummary(x.insight.statement);
  s.addText(summaryText, {
    x: 0.7, y: 1.95, w: 12.1, h: 0.6,
    fontSize: 13, fontFace: STYLE.fontFace, color: STYLE.textSubtle, valign: "top",
  });

  // ── §2 主要内容 / 关键思路 ──
  sectionHeader(s, "主要内容 · 关键思路", 2.65);
  // 完整 statement
  s.addText(x.insight.statement, {
    x: 0.7, y: 3.0, w: 12.1, h: 1.3,
    fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textPrimary, valign: "top",
  });
  // 关键引用（最多 2 条 verbatim quote）
  const cites = x.citationIndices.slice(0, 2).map((i) => x.insight.citations[i]);
  const quotesText: { text: string; options?: { fontSize?: number; color?: string; italic?: boolean; breakLine?: boolean } }[] = [];
  for (const c of cites) {
    const src = input.sourceNameByCi.get(c.content_item_id) ?? c.content_item_id;
    quotesText.push({
      text: `「${truncate(c.quote, 120)}」`,
      options: { fontSize: 11, color: STYLE.textSubtle, italic: true, breakLine: true },
    });
    quotesText.push({
      text: `— ${src}`,
      options: { fontSize: 9, color: STYLE.textMuted, breakLine: true },
    });
  }
  if (quotesText.length > 0) {
    s.addText(quotesText, {
      x: 0.7, y: 4.4, w: 12.1, h: 1.0,
      valign: "top", fontFace: STYLE.fontFace,
    });
  }

  // ── §3 对我们的启示（B：LLM 多 bullet；A fallback：importance_basis 整段）──
  sectionHeader(s, "对我们的启示", 5.55);
  if (polish?.implications && polish.implications.length > 0) {
    const implLines = polish.implications.map((t) => ({
      text: `· ${t}`,
      options: { breakLine: true, fontSize: 12, color: STYLE.textSubtle },
    }));
    s.addText(implLines, {
      x: 0.7, y: 5.9, w: 12.1, h: 1.0,
      fontFace: STYLE.fontFace, valign: "top", paraSpaceAfter: 4,
    });
  } else {
    s.addText(x.insight.importance_basis, {
      x: 0.7, y: 5.9, w: 12.1, h: 0.85,
      fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textSubtle, valign: "top",
    });
    s.addText("（A fallback：analyzer importance_basis；启用 LLM 润色后此处由 polish 重写）", {
      x: 0.7, y: 6.6, w: 12.1, h: 0.25,
      fontSize: 8, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true,
    });
  }

  // ── 页脚 ──
  s.addText(`${input.topic.name} · ${date}`, {
    x: 0.5, y: 6.95, w: 12.3, h: 0.25,
    fontSize: 9, fontFace: STYLE.fontFace, color: STYLE.textMuted, align: "right",
  });
}

/** §标题：小色块 + 文字。各页统一节奏。 */
function sectionHeader(
  s: ReturnType<InstanceType<typeof PptxGen>["addSlide"]>,
  text: string,
  y: number,
): void {
  s.addText(text, {
    x: 0.5, y, w: 12.3, h: 0.3,
    fontSize: 11, fontFace: STYLE.fontFace, color: STYLE.accent, bold: true,
  });
}

/** §1 用：抽 statement 首句作"简要总结"。优先按"。"切；无句号则截到 ~50 字。 */
export function briefSummary(statement: string): string {
  const m = statement.match(/^[^。！？.!?]{6,}[。！？.!?]/);
  if (m) return m[0].trim();
  return truncate(statement, 55);
}

/** 标题：pithy 截断；首句过长则截到 ~26 字。 */
function briefTitle(statement: string): string {
  const summary = briefSummary(statement);
  return summary.length > 28 ? truncate(summary, 28) : summary;
}

/** 返回新增页数。其他动态按 OTHER_PER_SLIDE 条/页聚合，每条一行。 */
function addOtherInsightSlides(pres: InstanceType<typeof PptxGen>, rest: IncludedInsightLite[]): number {
  let added = 0;
  for (let i = 0; i < rest.length; i += OTHER_PER_SLIDE) {
    const chunk = rest.slice(i, i + OTHER_PER_SLIDE);
    const s = pres.addSlide();
    s.background = { color: STYLE.bgColor };
    s.addText(`其他动态（${added + 1}/${Math.ceil(rest.length / OTHER_PER_SLIDE)}）`, {
      x: 0.5, y: 0.4, w: 12.3, h: 0.5,
      fontSize: 18, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
    });
    let y = 1.1;
    for (const x of chunk) {
      const lbl = flagLabel(x);
      const flag = lbl ? `  〔${lbl}〕` : "";
      s.addText(`· [${x.insight.importance}/5] ${truncate(x.insight.statement, 180)}${flag}`, {
        x: 0.6, y, w: 12.1, h: 1.3,
        fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textSubtle,
        valign: "top",
      });
      y += 1.4;
    }
    added += 1;
  }
  return added;
}

function addSourcesSlide(pres: InstanceType<typeof PptxGen>, input: PptGenInput): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  s.addText("源与方法", {
    x: 0.5, y: 0.4, w: 12.3, h: 0.5,
    fontSize: 22, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
  });

  // 收集所有引用涉及的 source_id（去重）
  const citedCi = new Set<string>();
  for (const x of input.insights) {
    for (const i of x.citationIndices) citedCi.add(x.insight.citations[i].content_item_id);
  }
  const sourceLabels = new Set<string>();
  for (const ci of citedCi) {
    const name = input.sourceNameByCi.get(ci);
    if (name) sourceLabels.add(name);
  }

  const sourceList = [...sourceLabels].sort();
  if (sourceList.length > 0) {
    const lines = sourceList.map((name) => ({ text: `· ${name}`, options: { breakLine: true } }));
    s.addText(lines, {
      x: 0.5, y: 1.2, w: 12.3, h: 4.5,
      fontSize: 13, fontFace: STYLE.fontFace, color: STYLE.textSubtle, valign: "top",
    });
  } else {
    s.addText("（未挂引用）", {
      x: 0.5, y: 1.2, w: 12.3, h: 1,
      fontSize: 13, fontFace: STYLE.fontFace, color: STYLE.textMuted,
    });
  }

  s.addText(
    `生成于 ${input.report.generated_at.slice(0, 10)} · 报告 ID: ${input.report.id} · 引用经独立校验器（Opus-class）逐字验证`,
    {
      x: 0.5, y: 6.8, w: 12.3, h: 0.4,
      fontSize: 9, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true,
    },
  );
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}
