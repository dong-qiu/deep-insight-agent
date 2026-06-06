import { defineConfig } from "vitest/config";

/** Vitest 极简配置：仅为 TSX 测试启用 automatic JSX runtime（C-2 起）。
 *  Next.js 自己用 jsx: "preserve" 在 build 期完成转换，vitest 旁路独立处理。 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
});
