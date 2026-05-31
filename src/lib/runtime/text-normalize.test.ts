import { describe, expect, it } from "vitest";
import { collapseWithMap, compareKey, normalizeTypography } from "./text-normalize.js";

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

describe("compareKey（F3 单点比较键）", () => {
  it("等同于 typography fold + 空白折叠 + trim", () => {
    expect(compareKey("  He’d  said   “hi”\n…\nthen  ")).toBe("He'd said \"hi\" ... then");
  });

  it("幂等：再过一次不变", () => {
    const once = compareKey('  "Coasters:" \t learning  ');
    expect(compareKey(once)).toBe(once);
  });
});

describe("collapseWithMap（F1 offset map）", () => {
  it("key 与 compareKey 结果一致", () => {
    const body = "  He’d said “hi”\n…\n  then  ";
    const { key } = collapseWithMap(body);
    expect(key).toBe(compareKey(body));
  });

  it("map 不变量：body[map[i]] 是 key[i] 的源字符（fold 前形态）", () => {
    const body = "He’d said";
    const { key, map } = collapseWithMap(body);
    expect(key).toBe("He'd said");
    expect(map.length).toBe(key.length);
    // 'H' → body[0] 'H'
    expect(body[map[0]]).toBe("H");
    // ''' (key[2]) → body[2] '’' (U+2019)
    expect(body[map[2]]).toBe("’");
    // 'd' (key[3]) → body[3] 'd'
    expect(body[map[3]]).toBe("d");
  });

  it("空白折叠：key 中的单空格 map 指向 body 中**第一个**空白字符", () => {
    const body = "He\n\nsaid";
    const { key, map } = collapseWithMap(body);
    expect(key).toBe("He said");
    expect(map[2]).toBe(2); // key 中的 ' ' 指向 body 第一个 '\n'
    expect(body[map[2]]).toBe("\n");
  });

  it("ellipsis 一字三映：3 个 key 字符都指向同一个 body 字符", () => {
    const body = "wait…then";
    const { key, map } = collapseWithMap(body);
    expect(key).toBe("wait...then");
    // key[4..7] = "..." 都指向 body[4] = '…'
    expect(map[4]).toBe(4);
    expect(map[5]).toBe(4);
    expect(map[6]).toBe(4);
    expect(body[map[4]]).toBe("…");
  });

  it("trim 语义：首尾空白不进 key 也不进 map", () => {
    const body = "  hi  ";
    const { key, map } = collapseWithMap(body);
    expect(key).toBe("hi");
    expect(map).toEqual([2, 3]);
  });

  it("F1 核心用法：用 map 切回 body 原始字节（含 smart quote、原始空白）", () => {
    const body = "  He’d\n\nsaid “hi”  ";
    const { key, map } = collapseWithMap(body);
    // 在 key 上匹配 "He'd said \"hi\""（全部）
    const at = 0;
    const len = key.length;
    const sliced = body.slice(map[at], map[at + len - 1] + 1);
    // 切回 body 原始字节：含 smart quote、含 \n\n
    expect(sliced).toBe("He’d\n\nsaid “hi”");
  });
});
