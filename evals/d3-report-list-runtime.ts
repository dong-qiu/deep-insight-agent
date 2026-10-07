/** Private injection and diagnostic observers for an offline page bundle only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";
import type { DB } from "../src/lib/db/connection.js";

export interface Metric { calls: number; ms: number; errors: number }
export interface SqlMetric extends Metric { sql: string; prepareCalls: number; prepareMs: number; rows: number; logicalBytes: number; args: unknown[] }
export interface Observation {
  functions: Record<string, Metric>;
  sql: Record<string, SqlMetric>;
  fs: Record<string, Metric & { bytes: number; categories: Record<string, number> }>;
}
let db: DB | undefined;
let observation: Observation | undefined;
export const newObservation = (): Observation => ({ functions: {}, sql: {}, fs: {} });
export function setBenchmarkDb(value: DB | undefined) { db = value; }
export function benchmarkDb() { assert(db, "benchmark db not injected"); return db; }
export function measure<T>(name: string, action: () => T): T {
  if (!observation) return action();
  const item = observation.functions[name] ??= { calls: 0, ms: 0, errors: 0 };
  const start = performance.now();
  try { return action(); } catch (error) { item.errors++; throw error; }
  finally { item.calls++; item.ms += performance.now() - start; }
}

function observedDb(target: DB): DB {
  return new Proxy(target, { get(connection, prop) {
    if (prop !== "prepare") {
      const value = Reflect.get(connection, prop);
      return typeof value === "function" ? value.bind(connection) : value;
    }
    return (sql: string) => {
      assert(observation);
      const entry = observation.sql[sql] ??= { sql, calls: 0, ms: 0, errors: 0, prepareCalls: 0, prepareMs: 0, rows: 0, logicalBytes: 0, args: [] };
      const start = performance.now();
      let statement;
      try { statement = connection.prepare(sql); }
      finally { entry.prepareCalls++; entry.prepareMs += performance.now() - start; }
      return new Proxy(statement, { get(stmt, member) {
        const value = Reflect.get(stmt, member);
        if (member !== "all" && member !== "get") return typeof value === "function" ? value.bind(stmt) : value;
        return (...args: unknown[]) => {
          const started = performance.now();
          let result: unknown;
          try { result = value.apply(stmt, args); }
          catch (error) { entry.errors++; throw error; }
          finally { entry.calls++; entry.ms += performance.now() - started; }
          entry.args = args;
          entry.rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
          entry.logicalBytes += Buffer.byteLength(JSON.stringify(result) ?? "");
          return result;
        };
      } });
    };
  } });
}

const fsMethods = ["readFileSync", "readSync", "openSync", "closeSync", "statSync", "lstatSync", "fstatSync", "realpathSync", "existsSync"] as const;
/** Patches builtins for the duration of one isolated synchronous read/render; always restores on failure. */
export async function observe<T>(connection: DB, root: string, action: () => Promise<T> | T): Promise<{ result: T; observation: Observation }> {
  assert(!observation, "nested observation");
  const priorDb = db, metrics = newObservation();
  const methods = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map(fsMethods.map(name => [name, methods[name]!]));
  observation = metrics;
  db = observedDb(connection);
  for (const name of fsMethods) {
    const original = originals.get(name)!;
    methods[name] = (...args: unknown[]) => {
      const entry = metrics.fs[name] ??= { calls: 0, ms: 0, errors: 0, bytes: 0, categories: {} };
      const path = typeof args[0] === "string" ? resolve(args[0]) : "fd";
      const category = path.startsWith(resolve(root, "raw") + sep) ? "archive" : path.startsWith(resolve(root, "reports") + sep) ? "report" : "other-or-fd";
      entry.categories[category] = (entry.categories[category] ?? 0) + 1;
      const start = performance.now();
      try {
        const value = original(...args);
        if (name === "readFileSync") entry.bytes += typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 0;
        if (name === "readSync" && typeof value === "number") entry.bytes += value;
        return value;
      } catch (error) { entry.errors++; throw error; }
      finally { entry.calls++; entry.ms += performance.now() - start; }
    };
  }
  syncBuiltinESMExports();
  try { return { result: await action(), observation: metrics }; }
  finally {
    for (const [name, original] of originals) methods[name] = original;
    syncBuiltinESMExports();
    db = priorDb;
    observation = undefined;
  }
}

export function stats(samples: readonly number[]) {
  assert(samples.length >= 40 && samples.every(n => Number.isFinite(n) && n > 0), "invalid samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  const p50 = q(0.5), deviations = sorted.map(n => Math.abs(n - p50)).sort((a, b) => a - b);
  return { n: samples.length, p50, p95: q(0.95), min: sorted[0]!, max: sorted.at(-1)!, iqr: q(0.75) - q(0.25),
    mad: deviations[Math.ceil(0.5 * deviations.length) - 1]! };
}
export const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
