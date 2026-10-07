import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
export const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const nonempty = z.string().trim().min(1);
export const utc = z.string().refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const resourceSchema = z.object({ path: nonempty, sha256: digest }).strict();
export type Resource = z.infer<typeof resourceSchema>;
export function fileResource(path: string): Resource {
  if (!isAbsolute(path) || realpathSync(path) !== path || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("absolute_regular_resource_required");
  return { path, sha256: sha(readFileSync(path)) };
}
export function verifyResource(resource: Resource): void { if (fileResource(resource.path).sha256 !== resource.sha256) throw new Error("resource_hash_mismatch"); }
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required"); return value as Record<string, unknown>;
};
export const jsonBytes = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
/** JSON payload equality for protocols: finite decimal numbers are valid, key order is not identity. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical_json_invalid_value");
}
