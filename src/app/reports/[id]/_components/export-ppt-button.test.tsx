import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportPptButton } from "./export-ppt-button.js";

describe("ExportPptButton", () => {
  it("只提供确定性的原文证据导出入口，不暴露润色参数", () => {
    const html = renderToStaticMarkup(<ExportPptButton reportId="rep_1" />);

    expect(html).toContain("导出 PPT");
    expect(html).toContain("原文证据模式");
    expect(html).not.toContain("LLM 润色");
    expect(html).not.toContain("polish");
    expect(html).not.toContain("refresh");
  });
});
