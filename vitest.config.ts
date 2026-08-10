import { defineConfig } from "vitest/config";

/** Vitest 配置：① TSX 测试用 automatic JSX runtime（C-2 起；Next 自己 build 期转换，vitest 旁路）。
 *     Vite 8 改用 Rolldown/Oxc，`esbuild` 配置会被兼容层转换且与 Vitest 的 Oxc 默认配置冲突；
 *     因此直接使用 Oxc 的 JSX 配置，确保 .tsx 与含 `import type` 的源码和测试均按 TypeScript/JSX 解析。
 *  ② 覆盖率（质量 Q4）：v8 provider，度量 src 源码（排除测试/类型/桶文件）。
 *     `npm run test:coverage` 出报告；CI 以当前基线作下限，阻断覆盖率回退。 */
export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
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
      // 以本次实测基线为下限；任何覆盖率回退都会在 CI 阻断。提升阈值应伴随有针对性的测试增量。
      thresholds: {
        global: {
          statements: 64,
          branches: 55,
          functions: 61,
          lines: 65,
        },
      },
    },
  },
});
