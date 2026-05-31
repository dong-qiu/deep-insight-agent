import { describe, expect, it } from "vitest";
import { normalizeTypography } from "./text-normalize.js";

describe("normalizeTypography", () => {
  it("单引号系 → ASCII '（U+2018/19/1A/1B；**不含** U+2032 prime 见后续测试）", () => {
    expect(normalizeTypography("He’d")).toBe("He'd");
    expect(normalizeTypography("‘x’")).toBe("'x'");
    expect(normalizeTypography("dair.ai’s")).toBe("dair.ai's");
  });

  it("双引号系 → ASCII \"（U+201C/D/E/F；**不含** U+2033 double-prime 见后续测试）", () => {
    expect(normalizeTypography("“Coasters:”")).toBe('"Coasters:"');
    expect(normalizeTypography("„trust‟")).toBe('"trust"');
  });

  it("en/em dash + minus → -", () => {
    expect(normalizeTypography("A–B—C−D")).toBe("A-B-C-D");
  });

  it("ellipsis 字符 → ...", () => {
    expect(normalizeTypography("wait…")).toBe("wait...");
  });

  it("non-breaking space → 普通空格", () => {
    expect(normalizeTypography("a b")).toBe("a b");
  });

  it("空字符串 / ASCII 全样保留", () => {
    expect(normalizeTypography("")).toBe("");
    expect(normalizeTypography("plain ASCII 'text'")).toBe("plain ASCII 'text'");
  });

  it("rep_54ed154e 真实案例：He’d seen / “Coasters” / We’ve also", () => {
    expect(normalizeTypography("He’d seen the static")).toBe("He'd seen the static");
    expect(normalizeTypography("“Coasters:” learning")).toBe('"Coasters:" learning');
    expect(normalizeTypography("We’ve also seen costly")).toBe("We've also seen costly");
  });

  it("**不**折度量/科学符号 prime ′ U+2032、double-prime ″ U+2033（语义≠引号，安全边界）", () => {
    // 度数/弧分/英尺
    expect(normalizeTypography("5′ 11″ tall")).toBe("5′ 11″ tall");
    // 派生符号在数学场景
    expect(normalizeTypography("f′(x) = 2x")).toBe("f′(x) = 2x");
  });

  it("CJK 全形引号 「」『』 → \"（多语言溯源覆盖）", () => {
    expect(normalizeTypography("他说「你好」")).toBe('他说"你好"');
    expect(normalizeTypography("『重点』标记")).toBe('"重点"标记');
  });
});
