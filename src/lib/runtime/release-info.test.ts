import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReleaseTime, getReleaseInfo, parseReleaseInfo, shortGitSha } from "./release-info.js";

describe("release info", () => {
  it("keeps the immutable version, revision, and UTC release timestamp", () => {
    const info = parseReleaseInfo({
      version: "0.1.0",
      git_sha: "79d1e41b79c88ddb475653c31d212dfcd0915a90",
      released_at: "2026-09-08T12:54:57Z",
    }, "0.0.0");

    expect(info).toEqual({
      version: "0.1.0",
      gitSha: "79d1e41b79c88ddb475653c31d212dfcd0915a90",
      releasedAt: "2026-09-08T12:54:57.000Z",
    });
    expect(shortGitSha(info.gitSha)).toBe("79d1e41");
    expect(formatReleaseTime(info.releasedAt)).toBe("2026-09-08 12:54:57 UTC");
  });

  it("falls back safely when build metadata is absent or malformed", () => {
    expect(parseReleaseInfo({ version: "", git_sha: "not-a-sha", released_at: "not-a-time" }, "0.1.0"))
      .toEqual({ version: "0.1.0" });
  });

  it("does not present a partial receipt as a published release", () => {
    expect(parseReleaseInfo({
      version: "99.99.99",
      released_at: "2026-09-08T13:30:00Z",
    }, "0.1.0")).toEqual({ version: "0.1.0" });
  });

  it("rejects a non-UTC timestamp or abbreviated revision", () => {
    expect(parseReleaseInfo({
      version: "0.1.0",
      git_sha: "79d1e41",
      released_at: "September 8, 2026 13:30 UTC",
    }, "0.1.0")).toEqual({ version: "0.1.0" });
  });

  it("reads metadata packaged with the release image", () => {
    const cwd = mkdtempSync(join(tmpdir(), "release-info-"));
    try {
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(cwd, "build-info.json"), JSON.stringify({
        version: "0.1.1",
        git_sha: "0123456789abcdef0123456789abcdef01234567",
        released_at: "2026-09-08T13:30:00Z",
      }));
      expect(getReleaseInfo(cwd)).toEqual({
        version: "0.1.1",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
        releasedAt: "2026-09-08T13:30:00.000Z",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
