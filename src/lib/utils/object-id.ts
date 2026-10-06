import { randomBytes } from "node:crypto";

/** New application objects only; readers continue to accept historical IDs. */
export function newObjectId(prefix: "run" | "rep" | "fup" | "lead" | "opp"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
