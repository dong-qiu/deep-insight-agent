/** coerceStringifiedFields 纯函数单测（6b 防御：模型偶发把 array/object 字段返成 JSON 字符串）。 */
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { coerceStringifiedFields } from "./llm.js";

describe("coerceStringifiedFields（6b 结构化输出防御）", () => {
  const schema = z.object({ insights: z.array(z.string()) });

  it("array 字段被序列化成字符串 → 定点 JSON.parse 修回数组，再校验通过", () => {
    const bad = { insights: '["a","b"]' };
    const issues = schema.safeParse(bad).error!.issues;
    const fixed = coerceStringifiedFields(bad, issues);
    expect(fixed).toEqual({ insights: ["a", "b"] });
    expect(schema.safeParse(fixed).success).toBe(true);
  });

  it("嵌套 object 字段同理", () => {
    const s = z.object({ meta: z.object({ k: z.string() }) });
    const bad = { meta: '{"k":"v"}' };
    expect(coerceStringifiedFields(bad, s.safeParse(bad).error!.issues)).toEqual({ meta: { k: "v" } });
  });

  it("非 array/object 类型错（如 number）→ 不修正、返 null", () => {
    const s = z.object({ n: z.number() });
    const bad = { n: "abc" };
    expect(coerceStringifiedFields(bad, s.safeParse(bad).error!.issues)).toBeNull();
  });

  it("字符串不是合法 JSON → 不修正、返 null（不破坏原输出）", () => {
    const bad = { insights: "not json at all" };
    expect(coerceStringifiedFields(bad, schema.safeParse(bad).error!.issues)).toBeNull();
  });
});
