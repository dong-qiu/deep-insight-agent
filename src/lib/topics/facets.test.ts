import { describe, expect, it } from "vitest";
import {
  DOMAIN_VALUES, LENS_VALUES, domainFacet, domainValueOf, facetLabel, hasDomainFacet,
  isDomainValue, isLensValue, isValidFacet, lensFacet, lensValueOf, parseFacets,
} from "./facets.js";

describe("facets 受控词表（ADR-0010）", () => {
  it("domainFacet / lensFacet 构造 <维度>:<值>", () => {
    expect(domainFacet("software-engineering")).toBe("domain:software-engineering");
    expect(domainFacet("foundation-models")).toBe("domain:foundation-models");
    expect(lensFacet("business")).toBe("lens:business");
  });

  it("isValidFacet 认所有受控 domain / lens 值", () => {
    for (const d of DOMAIN_VALUES) expect(isValidFacet(domainFacet(d))).toBe(true);
    for (const l of LENS_VALUES) expect(isValidFacet(lensFacet(l))).toBe(true);
  });

  it("isValidFacet 拒未知值 / 缺前缀 / 非串", () => {
    expect(isValidFacet("domain:unknown")).toBe(false); // 词表外
    expect(isValidFacet("lens:unknown")).toBe(false); // lens 词表外
    expect(isValidFacet("software-engineering")).toBe(false); // 缺 domain: 前缀
    expect(isValidFacet("topic:foo")).toBe(false); // 维度未支持
    expect(isValidFacet("")).toBe(false);
    expect(isValidFacet(null)).toBe(false);
    expect(isValidFacet(42)).toBe(false);
  });

  it("domain 值已去 ai- 前缀（AI 是产品级前提，不进域值）", () => {
    expect(DOMAIN_VALUES).toEqual(["software-engineering", "security", "foundation-models"]);
    expect(DOMAIN_VALUES.some((d) => d.startsWith("ai-"))).toBe(false);
  });
});

describe("facets 取值/标签辅助（ADR-0010 Step2b + lens 后续）", () => {
  it("isDomainValue 校验裸 domain 值白名单", () => {
    expect(isDomainValue("software-engineering")).toBe(true);
    expect(isDomainValue("foundation-models")).toBe(true);
    expect(isDomainValue("garbage")).toBe(false);
    expect(isDomainValue("domain:software-engineering")).toBe(false); // 这是 facet 不是裸值
    expect(isDomainValue(null)).toBe(false);
  });

  it("isLensValue 校验裸 lens 值白名单", () => {
    expect(isLensValue("technical")).toBe(true);
    expect(isLensValue("business")).toBe(true);
    expect(isLensValue("garbage")).toBe(false);
    expect(isLensValue("lens:business")).toBe(false);
  });

  it("domainValueOf / lensValueOf 剥前缀回裸值；非法 → null", () => {
    expect(domainValueOf("domain:software-engineering")).toBe("software-engineering");
    expect(domainValueOf("domain:unknown")).toBeNull();
    expect(domainValueOf("lens:business")).toBeNull(); // lens facet 不是 domain
    expect(lensValueOf("lens:business")).toBe("business");
    expect(lensValueOf("domain:security")).toBeNull();
  });

  it("hasDomainFacet：含 ≥1 domain → true（lens-only → false）", () => {
    expect(hasDomainFacet(["domain:security", "lens:technical"])).toBe(true);
    expect(hasDomainFacet(["lens:business"])).toBe(false);
    expect(hasDomainFacet([])).toBe(false);
  });

  it("facetLabel 映人类标签（domain + lens）；未知回退原串", () => {
    expect(facetLabel("domain:software-engineering")).toBe("软件工程");
    expect(facetLabel("domain:foundation-models")).toBe("基础模型");
    expect(facetLabel("lens:business")).toBe("产业");
    expect(facetLabel("lens:technical")).toBe("技术");
    expect(facetLabel("topic:foo")).toBe("topic:foo"); // 非受控 facet 原样返
  });

  it("parseFacets：合法 JSON 数组原样、空/坏 JSON/非串 → []（Step2c 派生锚已退役）", () => {
    expect(parseFacets('["domain:foundation-models","lens:business"]')).toEqual(["domain:foundation-models", "lens:business"]);
    expect(parseFacets("[]")).toEqual([]);
    expect(parseFacets("not json")).toEqual([]);
    expect(parseFacets(undefined)).toEqual([]);
    expect(parseFacets(42)).toEqual([]);
  });
});
