/** 把默认 Topic/Source 播种进本地 SQLite（.data/insight.db），让 dev 站点有内容可看。
 *  幂等：已存在则跳过。用法：npm run seed */
import { existsSync, readFileSync } from "node:fs";
import { loadStaticConfig, seedDefaults } from "../src/lib/config/index.js";
import { openLocalBootstrapDb } from "../src/lib/db/local-bootstrap.js";

// 加载 .env.local（loadStaticConfig 需 LLM_API_KEY，Anthropic legacy alias 仍可解析）
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const dbPath = process.env.DB_PATH ?? ".data/insight.db";
const db = openLocalBootstrapDb(dbPath);
const result = seedDefaults(db, loadStaticConfig());
db.close();
console.log(`已播种默认配置 → ${process.env.DB_PATH ?? ".data/insight.db"}`);
console.log(`  新增主题 ${result.topics} · 新增数据源 ${result.sources}`);
