import { describe, expect, it } from "vitest";
import { parsePublishedAt } from "./parse-date.js";

describe("parsePublishedAt", () => {
  it("RFC 2822（GitHub Eng / 多数 RSS）→ ISO", () => {
    expect(parsePublishedAt("Tue, 31 Mar 2026 16:00:00 +0000")).toBe("2026-03-31T16:00:00.000Z");
    expect(parsePublishedAt("Thu, 12 Mar 2026 16:00:00 +0000")).toBe("2026-03-12T16:00:00.000Z");
    expect(parsePublishedAt("Fri, 03 Apr 2026 16:00:00 +0000")).toBe("2026-04-03T16:00:00.000Z");
  });

  it("已是 ISO 8601 → 归一化（带毫秒）", () => {
    expect(parsePublishedAt("2026-03-31T16:00:00Z")).toBe("2026-03-31T16:00:00.000Z");
    expect(parsePublishedAt("2026-03-31T16:00:00.123Z")).toBe("2026-03-31T16:00:00.123Z");
  });

  it("ISO 带时区偏移 → UTC 归一化", () => {
    expect(parsePublishedAt("2026-03-31T18:00:00+02:00")).toBe("2026-03-31T16:00:00.000Z");
    expect(parsePublishedAt("2026-03-31T11:00:00-05:00")).toBe("2026-03-31T16:00:00.000Z");
  });

  it("各种常见非标格式（V8 Date.parse 兜底）", () => {
    // arXiv 偶用空格分隔
    expect(parsePublishedAt("2026-03-31 16:00:00")).not.toBeNull();
    // 仅日期
    expect(parsePublishedAt("2026-03-31")).toBe("2026-03-31T00:00:00.000Z");
  });

  it("空 / null / 全空白 → null", () => {
    expect(parsePublishedAt(null)).toBeNull();
    expect(parsePublishedAt(undefined)).toBeNull();
    expect(parsePublishedAt("")).toBeNull();
    expect(parsePublishedAt("   ")).toBeNull();
  });

  it("无法解析的字符串 → null（不抛）", () => {
    expect(parsePublishedAt("not a date")).toBeNull();
    expect(parsePublishedAt("最近")).toBeNull();
  });

  it("归一化后字典序 = 时间序（解决根因）", () => {
    const dates = [
      "Wed, 28 Jan 2026 17:00:00 +0000",
      "Tue, 31 Mar 2026 16:00:00 +0000",
      "Thu, 14 May 2026 16:00:00 +0000",
      "Thu, 12 Mar 2026 16:00:00 +0000",
    ];
    const iso = dates.map((d) => parsePublishedAt(d)!);
    const sorted = [...iso].sort().reverse(); // 字典序倒序
    expect(sorted).toEqual([
      "2026-05-14T16:00:00.000Z", // 最新
      "2026-03-31T16:00:00.000Z",
      "2026-03-12T16:00:00.000Z",
      "2026-01-28T17:00:00.000Z", // 最早
    ]);
  });
});
