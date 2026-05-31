/** Typography 标准化（validator.checkReachability / analyzer.repairQuote 共用比较键）。
 *
 *  **比较语义约定**：本函数定义"fold-equivalent 比较键"——即使两侧字符串的字节不完全相等，
 *  只要 fold 后相等就视为同一。**这弱化了"逐字"的字节级承诺为视觉/语义级承诺**。
 *  消费者（report 渲染、locator、content_hash 等）若依赖 byte-verbatim，**不应**调用本函数。
 *
 *  fold 规则（仅折"视觉/语义等价"字符；不折度量/科学符号）：
 *  - 单引号系：U+2018 ‘ · U+2019 ’ · U+201A ‚ · U+201B ‛ → '   （**不含** U+2032 ′ prime，
 *    后者是度量符号「分/弧分/英尺/导数」，与引号语义不同——见 Sonnet 评审 concern[0]）
 *  - 双引号系：U+201C “ · U+201D ” · U+201E „ · U+201F ‟ → "   （**不含** U+2033 ″ double-prime
 *    度量符号「秒/弧秒/英寸」）
 *  - CJK 全形引号：U+300C 「 · U+300D 」 → " ；U+300E 『 · U+300F 』 → "（中文文本溯源覆盖）
 *  - dash 系：U+2013 – en / U+2014 — em / U+2212 − minus → -
 *  - U+2026 … ellipsis → "..."
 *  - U+00A0 nbsp → 普通空格
 *
 *  **不在 fold 表的**：U+2032 ′ prime · U+2033 ″ double-prime · 阿拉伯/希伯来引号（暂未覆盖）。
 *
 *  动机：rep_54ed154e 抽样审计 13/13 blocked quote_not_in_source 全是 body smart quotes
 *  vs 模型产出 ASCII。fold 后双侧比较 100% 恢复。 */
export function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'") // 单引号系（不含 prime ′ U+2032：度量符号）
    .replace(/[“”„‟]/g, '"') // 双引号系（不含 double-prime ″ U+2033：度量符号）
    .replace(/[「『]/g, '"') // CJK 全形左引号 → "
    .replace(/[」』]/g, '"') // CJK 全形右引号 → "
    .replace(/[–—−]/g, "-") // en/em dash, minus → -
    .replace(/…/g, "...") // ellipsis … → ...
    .replace(/ /g, " "); // non-breaking space → 普通空格（用转义防 Write 工具吞字符）
}

/** 比较键（F3 单点）：validator.checkReachability / analyzer.repairQuote 双侧 substring 对比
 *  前都过这里。语义见本文件顶部 fold 表 + "fold-equivalent" 契约文档。 */
export function compareKey(s: string): string {
  return normalizeTypography(s).replace(/\s+/g, " ").trim();
}

/** 比较键 + 位置映射（F1）：返回 key（同 compareKey 结果）+ map（key[i] → 来源 body 字符偏移）。
 *  repairQuote 用此把"在 key 上匹配的子串"映射回 body **原始字节**（含 smart quotes / 块内空白）
 *  并切片返回，保 byte-verbatim；computeLocator 据此能直接 body.indexOf 命中（F2）。 */
export function collapseWithMap(body: string): { key: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let inLeadingWs = true;
  let pendingWsAt = -1; // 中间空白：暂存第一个 ws 偏移，等下一个非 ws 到达才落 1 个空格
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (/\s/.test(ch)) {
      if (!inLeadingWs && pendingWsAt < 0) pendingWsAt = i;
      continue;
    }
    if (inLeadingWs) {
      inLeadingWs = false;
    } else if (pendingWsAt >= 0) {
      out.push(" ");
      map.push(pendingWsAt);
      pendingWsAt = -1;
    }
    // typography fold 是单字符输入；多数 → 1 字符（smart quote/dash），偶有 1→3（… → ...）
    const folded = normalizeTypography(ch);
    for (const fc of folded) {
      out.push(fc);
      map.push(i);
    }
  }
  // 尾部 pendingWs 故意丢弃（trim 语义）
  return { key: out.join(""), map };
}
