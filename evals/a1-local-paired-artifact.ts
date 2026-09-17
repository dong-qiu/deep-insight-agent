/**
 * Publish two local-only artifacts with recoverable, byte-exact semantics. A filesystem cannot
 * atomically rename arbitrary sibling files as one unit, so the second-write crash window is
 * handled explicitly: a retry may publish only the missing counterpart when the existing bytes
 * exactly match the newly derived bytes. It never overwrites either evidence artifact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LocalPairArtifact {
  path: string;
  bytes: Buffer;
  label: string;
}

export interface LocalPairWriter {
  mkdir(path: string): void;
  writeExclusive(path: string, bytes: Buffer): void;
}

const defaultWriter: LocalPairWriter = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeExclusive: (path, bytes) => writeFileSync(path, bytes, { flag: "wx" }),
};

function sameBytes(path: string, expected: Buffer): boolean {
  try {
    return readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

/**
 * The first file is the durable anchor; retries can only add its missing companion. If a prior
 * write left different bytes at either target, fail closed and require a new output path.
 */
export function publishVerifiedLocalPair(
  primary: LocalPairArtifact,
  companion: LocalPairArtifact,
  writer: LocalPairWriter = defaultWriter,
): "published" | "recovered" | "already_published" {
  if (primary.path === companion.path) throw new Error("paired artifact 的两个目标路径不可相同");
  const primaryExists = existsSync(primary.path);
  const companionExists = existsSync(companion.path);
  if (primaryExists && !sameBytes(primary.path, primary.bytes)) {
    throw new Error(`已有 ${primary.label} 与当前受控输入推导的字节不一致；拒绝覆盖`);
  }
  if (companionExists && !sameBytes(companion.path, companion.bytes)) {
    throw new Error(`已有 ${companion.label} 与当前受控输入推导的字节不一致；拒绝覆盖`);
  }
  if (primaryExists && companionExists) return "already_published";
  writer.mkdir(dirname(primary.path));
  writer.mkdir(dirname(companion.path));
  if (!primaryExists) writer.writeExclusive(primary.path, primary.bytes);
  if (!companionExists) writer.writeExclusive(companion.path, companion.bytes);
  return primaryExists || companionExists ? "recovered" : "published";
}
