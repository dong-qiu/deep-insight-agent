/** toHeadline 纯函数单测（确定性 statement→headline 浓缩）。用 max=10 让断点位置可手算。 */
import { describe, expect, it } from "vitest";
import { toHeadline } from "./backfill-highlights.mjs";

describe("toHeadline", () => {
  it("空串 → 空串", () => {
    expect(toHeadline("", 10)).toBe("");
  });

  it("不超长 → 原样（剥结尾句末标点）", () => {
    expect(toHeadline("短句。", 10)).toBe("短句");
    expect(toHeadline("完成！？.", 10)).toBe("完成"); // 多个结尾标点一起剥
    expect(toHeadline("  含首尾空白的结论。 ", 10)).toBe("含首尾空白的结论");
  });

  it("句中标点不剥（如定量小数 3.2）", () => {
    expect(toHeadline("结论是 3.2 千万", 10)).toBe("结论是 3.2 千万");
  });

  it("超长 + 区间内句末标点 → 在句末断 + …", () => {
    expect(toHeadline("前半句结束。后面还有很多内容继续", 10)).toBe("前半句结束…");
  });

  it("超长 + 仅子句标点 → 在子句断 + …", () => {
    expect(toHeadline("我的前半部分内容，后面更多内容", 10)).toBe("我的前半部分内容…");
  });

  it("超长 + 仅空格（英文）→ 词边界断，不切词中间 + …", () => {
    expect(toHeadline("alpha bravo charlie delta", 10)).toBe("alpha…");
  });

  it("超长 + 无任何断点 → 硬截到 max + …", () => {
    expect(toHeadline("abcdefghijklmnop", 10)).toBe("abcdefghij…");
  });

  it("ASCII 句号/叹号也算句末断点（nit2 回归守卫：曾漏判 . !）", () => {
    expect(toHeadline("Done here. More text follows", 10)).toBe("Done here…");
    // 若 "." 不在句末集合，会退化到空格断点 "Done…"，本断言钉住修复
  });

  it("按码点（非码元）计数：surrogate pair 不被截断成半个", () => {
    const r = toHeadline("😀".repeat(12), 10);
    expect(Array.from(r).length).toBe(11); // 10 emoji + …
    expect(r.endsWith("…")).toBe(true);
    expect(r).not.toContain("�"); // 无残缺代理对
  });

  it("默认 max=40：长 statement 收敛到 ≤41 码点（含尾 …）", () => {
    const long = "arXiv 论文系统化提出针对 LLM-based agent guardrail 自身的拒绝服务攻击，通过 beam-search 优化载荷实现 token 放大";
    expect(Array.from(toHeadline(long)).length).toBeLessThanOrEqual(41);
  });
});
