/** Private synthetic files only; no environment, backup adoption or cloud access. */
import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export function privateSyntheticPath(path: string, existing: boolean): void {
  if (!isAbsolute(path)) throw new Error("synthetic_registry_path_invalid");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("synthetic_registry_directory_not_private");
  if (existing) {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0) throw new Error("synthetic_registry_file_not_private");
  }
}
