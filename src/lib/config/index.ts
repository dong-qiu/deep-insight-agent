/** 配置加载（架构「配置分离」三层）：
 *  - 静态：defaults.yaml（构建时打包）；
 *  - 环境变量：`${VAR}` 引用解析，密钥唯一来源，缺失即拒（启动校验）；
 *  - 动态：用户 Source/Topic 落 SQLite，覆盖/扩充默认。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { DB } from "../db/index.js";
import { getSource, getTopic, insertSource, insertTopic, listSources } from "../db/repos.js";
import type { Source } from "../types.js";
import { type AppConfig, AppConfigSchema } from "./types.js";

// 默认相对编译产物定位 defaults.yaml；Next standalone 打包后该相对路径会失效，
// 容器内用 INSIGHT_CONFIG_PATH 指向固定路径（见 Dockerfile）覆盖。
const DEFAULTS_PATH =
  process.env.INSIGHT_CONFIG_PATH ?? join(dirname(fileURLToPath(import.meta.url)), "defaults.yaml");

/** 递归把字符串里的 ${VAR} 替换为环境变量；引用了未设置的变量即抛（密钥唯一来源 = env）。 */
export function resolveEnvRefs<T>(node: T): T {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`配置引用了未设置的环境变量：${name}`);
      return v;
    }) as T;
  }
  if (Array.isArray(node)) return node.map((x) => resolveEnvRefs(x)) as T;
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, resolveEnvRefs(v)]),
    ) as T;
  }
  return node;
}

/** 读 + 解析 ${VAR} + Zod 校验。任一缺失/非法即抛 —— 这就是启动校验。 */
export function loadStaticConfig(path: string = DEFAULTS_PATH): AppConfig {
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
  return AppConfigSchema.parse(resolveEnvRefs(raw));
}

/** 把默认 Topic/Source 幂等播种进 SQLite（已存在则跳过）。返回新增计数。 */
export function seedDefaults(db: DB, config: AppConfig): { topics: number; sources: number } {
  let topics = 0;
  let sources = 0;
  for (const t of config.defaultTopics) {
    if (!getTopic(db, t.id)) {
      insertTopic(db, t);
      topics++;
    }
  }
  for (const s of config.defaultSources) {
    if (!getSource(db, s.id)) {
      insertSource(db, s);
      sources++;
    }
  }
  return { topics, sources };
}

/** 有效模型对子：env 覆盖 > 静态默认（与 runtime/llm.ts 的 env 机制一致）。 */
export function getEffectiveModels(config: AppConfig): { analyzer: string; validator: string } {
  return {
    analyzer: process.env.ANALYZER_MODEL ?? config.models.analyzer,
    validator: process.env.VALIDATOR_MODEL ?? config.models.validator,
  };
}

/** 有效源：动态（SQLite）优先；库空则先播种默认再返回。 */
export function getEffectiveSources(db: DB, config: AppConfig): Source[] {
  let sources = listSources(db);
  if (sources.length === 0) {
    seedDefaults(db, config);
    sources = listSources(db);
  }
  return sources;
}
