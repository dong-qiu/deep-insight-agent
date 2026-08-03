/** 发布编排在 app/worker 启动前执行：npm run db:migrate。 */
import { openDb } from "../src/lib/db/index.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { initializeProvenanceMeta } from "../src/lib/db/provenance-facts.js";

const path = process.env.DB_PATH ?? ".data/insight.db";
const db = openDb(path);
applyProvenanceMigrations(db);
initializeProvenanceMeta(db);
db.close();
