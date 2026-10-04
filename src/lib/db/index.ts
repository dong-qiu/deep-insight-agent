/** Compatible persistence entry points. Schema fact source remains schema.ts. */
export type { DB } from "./connection.js";
export { openReadonlyDb } from "./connection.js";
export { openDb, getDb, closeDb } from "./startup.js";
