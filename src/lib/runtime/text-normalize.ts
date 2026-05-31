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
