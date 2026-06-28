import { describe, expect, it } from "vitest";
import { buildCanonicalizer, canonKey, ENTITY_ALIASES, normKey } from "./entity-normalize.js";

const ins = (...names: string[]) => ({ entities: names.map((name) => ({ name })) });

describe("normKey / canonKey", () => {
  it("normKey 只做大小写 + 去标点/空格", () => {
    expect(normKey("GPT-5.5")).toBe("gpt55");
    expect(normKey("GPT 5.5")).toBe("gpt55");
    expect(normKey("NVIDIA")).toBe(normKey("Nvidia"));
    expect(normKey("SWE-Bench")).toBe(normKey("SWE-bench"));
  });

  it("不同实体不归并：版本号/词不同 → key 不同", () => {
    expect(normKey("GPT-5.5")).not.toBe(normKey("GPT-5.6"));
    expect(normKey("Claude")).not.toBe(normKey("Claude Code"));
  });

  it("canonKey 先过别名表：Sakana AI → Sakana 同 key", () => {
    expect(canonKey("Sakana AI")).toBe(canonKey("Sakana"));
    expect(canonKey("Sakana AI")).toBe("sakana");
  });

  it("别名表无链式：value 不得再作 key（守 drill 展示名∈簇 不变量）", () => {
    const keys = new Set(Object.keys(ENTITY_ALIASES));
    for (const v of Object.values(ENTITY_ALIASES)) expect(keys.has(v)).toBe(false);
  });
});

describe("buildCanonicalizer", () => {
  it("变体归并到簇内最高频展示名", () => {
    // GPT-5.5 出现 2 次、GPT 5.5 出现 1 次 → 都归并到 GPT-5.5
    const canon = buildCanonicalizer([ins("GPT-5.5", "GPT 5.5"), ins("GPT-5.5")]);
    expect(canon("GPT 5.5")).toBe("GPT-5.5");
    expect(canon("GPT-5.5")).toBe("GPT-5.5");
  });

  it("别名表变体并入：Sakana AI → Sakana", () => {
    const canon = buildCanonicalizer([ins("Sakana AI"), ins("Sakana")]);
    expect(canon("Sakana AI")).toBe("Sakana");
    expect(canon("Sakana")).toBe("Sakana");
  });

  it("平票按字典序定（确定性）", () => {
    const canon = buildCanonicalizer([ins("NVIDIA"), ins("Nvidia")]); // 各 1 次
    expect(canon("Nvidia")).toBe("NVIDIA"); // "NVIDIA" < "Nvidia"（大写在前）
    expect(canon("NVIDIA")).toBe("NVIDIA");
  });

  it("不同实体不被归并", () => {
    const canon = buildCanonicalizer([ins("GPT-5.5", "GPT-5.6", "Claude", "Claude Code")]);
    expect(canon("GPT-5.6")).toBe("GPT-5.6");
    expect(canon("Claude Code")).toBe("Claude Code");
    expect(canon("Claude")).toBe("Claude");
  });

  it("无变体 → 恒等", () => {
    const canon = buildCanonicalizer([ins("OpenAI", "Anthropic")]);
    expect(canon("OpenAI")).toBe("OpenAI");
    expect(canon("Anthropic")).toBe("Anthropic");
  });
});
