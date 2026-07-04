import { defineConfig } from "vitest/config";

/** Vitest 配置：① TSX 测试用 automatic JSX runtime（C-2 起；Next 自己 build 期转换，vitest 旁路）。
 *     vitest 4 转换器由 esbuild 换成 oxc，旧 `esbuild.jsx` 被忽略（会告警且 .tsx 解析失败），改用 `oxc.jsx`。
 *  ② 覆盖率（质量 Q4）：v8 provider，度量 src 源码（排除测试/类型/桶文件）。
 *     `npm run test:coverage` 出报告；当前仅度量建基线、CI **不卡门**（避免脆弱阈值阻断）。 */
export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.d.ts",
        "src/lib/types.ts", // 纯类型，无运行时逻辑
      ],
    },
  },
});
