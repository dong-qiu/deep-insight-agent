/** 副作用模块：import 时即把 .env.local 载入 process.env。
 *  **必须在任何读 MODELS / 构造 SDK client 的模块 import 之前**（即放在 eval 脚本的第一行 import）——
 *  否则 `MODELS`（llm.ts 模块加载时求值）会用默认模型，导致 ANALYZER_MODEL/VALIDATOR_MODEL 不生效
 *  （6b 真机：默认 sonnet-4-6 经中转站 403）。已有同名变量不覆盖（shell 显式设的优先）。 */
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
