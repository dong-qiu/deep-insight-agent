/** PPT 生成（A 阶段：确定性骨架，无 LLM）。
 *  输入 = 已经过 `report-gen.selectInsights` 白名单的 IncludedInsight[]（仅 pass/support）+
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
 *  Reader-visible v6 never rewrites source facts with an LLM. Each slide prints its one
 *  auditable source quote exactly once, alongside a controlled system-importance label. */
import PptxGenJsImport from "pptxgenjs";
import type { Insight, Report, Topic } from "../types.js";
import { flagLabel } from "../utils/citation-verdict.js";

// pptxgenjs CJS/ESM 互操作不稳定：tsx 直接跑 ESM 路径返 { default } 而 vitest 走 CJS
// 路径直接返 class。此处兼容两种形态——确保任意 runtime 下 `new PptxGen()` 都成立。
const PptxGen: typeof PptxGenJsImport =
  (PptxGenJsImport as unknown as { default?: typeof PptxGenJsImport }).default ?? PptxGenJsImport;

export interface IncludedInsightLite {
  insight: Insight;
  citationIndices: number[]; // 仅明确 support 的 pass 引用
  // 保留渲染契约；生产发布路径恒为 false，flagged 只进入人工核实/重试队列。
  flaggedUncertain: boolean;
  flaggedError: boolean;
}

export interface PptGenInput {
  report: Report;
  insights: IncludedInsightLite[];
  topic: Topic;
  /** content_item_id → 可回溯来源。reader-visible quote 必须带其自身的安全原文 URL。 */
  citationSourceByCi: Map<string, { sourceName: string; url: string }>;
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
  // A source name alone cannot trace a reader back to the cited article.  Exclude malformed or
  // missing content links rather than presenting an unverifiable quote in a downloadable deck.
  const readerInput: PptGenInput = {
    ...input,
    insights: input.insights.filter((insight) => Boolean(bindingCitation(input, insight))),
  };
  const pres = new PptxGen();
  pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 inch

  let pages = 0;
  addTitleSlide(pres, readerInput);
  pages += 1;

  if (readerInput.insights.length === 0) {
    addEmptySlide(pres);
    pages += 1;
    return finish(pres, pages);
  }

  const key = readerInput.insights.filter((x) => x.insight.importance >= KEY_IMPORTANCE);
  const rest = readerInput.insights.filter((x) => x.insight.importance < KEY_IMPORTANCE);

  for (let i = 0; i < key.length; i++) {
    addKeyInsightSlide(pres, key[i], i + 1, readerInput);
    pages += 1;
  }

  if (rest.length > 0) {
    pages += addOtherInsightSlides(pres, rest, readerInput);
  }

  addSourcesSlide(pres, readerInput);
  pages += 1;

  return finish(pres, pages);
}

function bindingCitation(input: PptGenInput, insight: IncludedInsightLite): {
  quote: string;
  source: { sourceName: string; url: string };
} | null {
  const citationIndex = insight.citationIndices[0];
  const citation = citationIndex == null ? undefined : insight.insight.citations[citationIndex];
  const source = citation ? input.citationSourceByCi.get(citation.content_item_id) : undefined;
  return citation && source && /^https?:\/\//i.test(source.url)
    ? { quote: citation.quote, source }
    : null;
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

function addEmptySlide(pres: InstanceType<typeof PptxGen>): void {
  const s = pres.addSlide();
  s.background = { color: STYLE.bgColor };
  s.addText("本期无重要事件", {
    x: 0.5, y: 3.2, w: 12.3, h: 1, align: "center",
    fontSize: 28, fontFace: STYLE.fontFace, color: STYLE.textMuted, italic: true,
  });
}

/** 重点条单页：source quote 一次 + 受控系统重要性。 */
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

  // Do not repeat a source quote in a generated title. The title is structural only; the quote
  // below is the one and only reader-visible factual statement on this slide.
  s.addText(`重点洞察 #${n}`, {
    x: 0.5, y: 0.65, w: 12.3, h: 0.85,
    fontSize: 22, fontFace: STYLE.fontFace, color: STYLE.textPrimary, bold: true,
    valign: "top",
  });

  sectionHeader(s, "已核验原文", 1.6);
  const bound = bindingCitation(input, x);
  if (bound) {
    const quoteText: PptxGenJsImport.TextProps[] = [
      { text: `「${bound.quote}」`, options: { fontSize: 11, color: STYLE.textSubtle, italic: true, breakLine: true } },
      { text: `— ${bound.source.sourceName}`, options: { fontSize: 9, color: STYLE.textMuted, breakLine: true, hyperlink: { url: bound.source.url, tooltip: "打开已核验原文" } } },
    ];
    s.addText(quoteText, {
      x: 0.7, y: 1.95, w: 12.1, h: 2.2,
      valign: "top", fontFace: STYLE.fontFace, fit: "shrink",
    });
  }

  sectionHeader(s, "系统重要性判断", 4.65);
  s.addText(x.insight.importance_basis, {
    x: 0.7, y: 5.0, w: 12.1, h: 0.85,
    fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textSubtle, valign: "top",
  });

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

/** 返回新增页数。其他动态按 OTHER_PER_SLIDE 条/页聚合，每条一行。 */
function addOtherInsightSlides(pres: InstanceType<typeof PptxGen>, rest: IncludedInsightLite[], input: PptGenInput): number {
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
      const bound = bindingCitation(input, x)!;
      const text: PptxGenJsImport.TextProps[] = [
        { text: `· [${x.insight.importance}/5] 「${bound.quote}」${flag}`, options: { breakLine: true } },
        { text: `— ${bound.source.sourceName}`, options: { fontSize: 9, color: STYLE.textMuted, hyperlink: { url: bound.source.url, tooltip: "打开已核验原文" } } },
      ];
      s.addText(text, {
        x: 0.6, y, w: 12.1, h: 1.3,
        fontSize: 12, fontFace: STYLE.fontFace, color: STYLE.textSubtle,
        valign: "top", fit: "shrink",
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
    const source = input.citationSourceByCi.get(ci);
    if (source) sourceLabels.add(source.sourceName);
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
