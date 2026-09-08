import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReleaseInfo {
  version: string;
  gitSha?: string;
  releasedAt?: string;
}

interface BuildInfo {
  version?: unknown;
  git_sha?: unknown;
  released_at?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const timestamp = stringValue(value);
  if (!timestamp || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) return undefined;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const normalizedInput = timestamp.includes(".") ? timestamp : timestamp.replace("Z", ".000Z");
  return parsed.toISOString() === normalizedInput ? normalizedInput : undefined;
}

/** Parse public, immutable image metadata and ignore malformed optional values. */
export function parseReleaseInfo(buildInfo: BuildInfo | undefined, fallbackVersion: string): ReleaseInfo {
  const version = stringValue(buildInfo?.version);
  const gitSha = stringValue(buildInfo?.git_sha)?.match(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)?.[0];
  const releasedAt = isoTimestamp(buildInfo?.released_at);
  // A partial record could pair an old timestamp with an unrelated source tree.
  // Treat every incomplete release receipt as local development rather than
  // presenting it as a published release.
  if (!version || !gitSha || !releasedAt) return { version: fallbackVersion };
  return {
    version,
    gitSha,
    releasedAt,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Read metadata baked into the image. Local development has no build-info file,
 * so it deliberately falls back to the checked-out package version without a
 * fabricated release timestamp.
 */
export function getReleaseInfo(cwd = process.cwd()): ReleaseInfo {
  const packageInfo = readJson(join(cwd, "package.json")) as { version?: unknown } | undefined;
  const fallbackVersion = stringValue(packageInfo?.version) ?? "0.0.0";
  return parseReleaseInfo(readJson(join(cwd, "build-info.json")) as BuildInfo | undefined, fallbackVersion);
}

export function shortGitSha(gitSha: string | undefined): string | undefined {
  return gitSha?.slice(0, 7);
}

export function formatReleaseTime(releasedAt: string | undefined): string | undefined {
  return releasedAt?.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
