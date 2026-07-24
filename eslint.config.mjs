import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import path from "node:path";

const baseDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

/**
 * Next 15 的官方规则仍以 eslintrc shareable config 发布；通过 FlatCompat 接入 ESLint 9
 * 的 flat config。lint 只检查可维护的源码目录，生成物及依赖一律排除。
 */
const config = [
  { ignores: [".next/**", "coverage/**", "node_modules/**"] },
  ...compat.extends("next/core-web-vitals"),
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
];

export default config;
