/** XML 解析共享件（arXiv Atom / RSS 都用）。 */
import { XMLParser } from "fast-xml-parser";

export const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** 取 XML 节点文本：字符串直接返回；对象取其 #text；其余 String 化。 */
export function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return String(v);
}
