/** Ledger-only CLI. Does not load env, execute shell commands, or call AWS. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initialize, openLedger } from "./ledger.mjs";

export function run(args, input) {
  const [root, action] = args;
  if (args.length !== 2) throw new Error("usage: cli.mjs <canonical-isolated-root> <action>; JSON on stdin");
  if (action === "init") { initialize(root, input); return { initialized: true, production_permitted: false }; }
  const ledger = openLedger(root);
  try {
    const actions = {
      inspect: () => ledger.inspect(), acquire: () => ledger.acquire(input),
      "begin-submit": () => ledger.beginSubmit(input.token, input.commandHash),
      "bind-command": () => ledger.bindCommand(input.token, input.binding),
      observe: () => ledger.observe(input.token, input.response), cancel: () => ledger.cancel(input.token),
      hold: () => ledger.hold(input.token, input.reason), complete: () => ledger.complete(input.token),
      authorize: () => ledger.authorize(input),
    };
    if (!Object.hasOwn(actions, action)) throw new Error("invalid_maintenance_action");
    return { result: actions[action](), production_permitted: false };
  } finally { ledger.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = readFileSync(0, "utf8");
    if (Buffer.byteLength(raw) > 16384) throw new Error("maintenance_input_too_large");
    console.log(JSON.stringify(run(process.argv.slice(2), raw.trim() ? JSON.parse(raw) : null)));
  } catch (error) {
    // Never print arbitrary input, keys, paths or native SQLite diagnostics.
    const message = error instanceof Error ? error.message : "maintenance_failed";
    console.error(/^[a-z][a-z_]+$/.test(message) ? message : "maintenance_failed");
    process.exitCode = 1;
  }
}
