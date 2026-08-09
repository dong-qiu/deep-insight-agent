import { globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

/**
 * Next 16 的官方规则直接发布为 ESLint flat config；不经 FlatCompat 转换，避免把
 * 已含插件对象的 flat config 当作旧式 eslintrc 校验。lint 只检查可维护的源码目录。
 */
const config = [
  ...nextVitals,
  globalIgnores([".next/**", "coverage/**", "node_modules/**"]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    // React Compiler rules newly included by Next 16 flag existing server-page
    // clock reads and effect-driven graph/form initialization. Keep the prior
    // lint contract; migrate these components in a dedicated refactor.
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default config;
