/** 把外部源（RSS / arXiv / API）的 published_at 字符串统一归一化到 ISO 8601 UTC。
 *
 *  痛点（dogfood 2026-06-06 发现）：
 *  - RSS 多用 RFC 2822（"Tue, 31 Mar 2026 16:00:00 +0000"），arXiv 用 ISO 但带 "Z"，
 *    自定义 API 偶用 "2026-03-31 16:00:00" 无时区——SQL ORDER BY 在这些字符串上做的是
 *    **字典序**，与时间序完全不一致（"Wed" > "Tue" > "Thu"...）；
 *  - 之前 report-gen 用 `slice(0, 10)` 切前 10 个字符当日期，RFC 2822 直接产生
 *    "Tue, 02 Ju" 截断垃圾；
 *  - 窗口过滤 listContentForTopic 用 `fetched_at >= since`、不是 published_at，
 *    导致旧文章被反复"重新抓回"看似新鲜（GitHub Eng 3 月文章今天还在 brief 里）。
 *
 *  本函数：尽力解析任何常见格式 → 返 ISO 8601（"YYYY-MM-DDTHH:mm:ssZ"）；解析失败 → null。
 *  归一化后 SQL 字典序 = 时间序，问题一并解决。 */

/** 解析任意常见日期字符串到 ISO 8601 UTC；解析失败返 null（不抛）。
 *  - 已是 ISO 8601 → 直接返（防重复 parse 误差）；
 *  - 否则交给 Date.parse 兜底（覆盖 RFC 2822 + RFC 850 + ISO 多种变体）。 */
export function parsePublishedAt(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 已是 ISO 8601（如 "2026-03-31T16:00:00Z" 或 "2026-03-31T16:00:00.000Z"）→ 原样
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  // Date.parse 兜底（V8/Node 实现支持 RFC 2822 + ISO + 一些常见非标）
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}
