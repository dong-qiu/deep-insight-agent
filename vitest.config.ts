import { defineConfig } from "vitest/config";

/** Vitest 配置：① TSX 测试用 automatic JSX runtime（C-2 起；Next 自己 build 期转换，vitest 旁路）。
 *     vite 钉在 6（见 package.json）：vitest 4 的 vite peer 范围很宽，npm 10（CI）会解到 vite 6/esbuild、
 *     npm 11 解到 vite 8/oxc，两者转换器与 JSX 配置不同且 vite 8 的 rolldown 原生 binding 撞 npm ci bug#4828；
 *     故显式钉 vite 6，全环境统一走 esbuild、此处沿用 `esbuild.jsx`。
 *  ② 覆盖率（质量 Q4）：v8 provider，度量 src 源码（排除测试/类型/桶文件）。
 *     `npm run test:coverage` 出报告；当前仅度量建基线、CI **不卡门**（避免脆弱阈值阻断）。 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
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
