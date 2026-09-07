import { describe, expect, it } from "vitest";
import { collectCohort, resolveCohortSources, resolveIsolatedCohortPaths } from "./collect-source-cohort.js";
import type { Source } from "../src/lib/types.js";

const source = (id: string): Source => ({
  id, name: id, type: "rss", endpoint: `https://example.test/${id}`, topic_ids: ["t_code_agents"], fetch_interval: "daily",
  backfill: null, enabled: false, fetch_mode: "feed", content_container: null,
});

describe("source cohort collection", () => {
  it("按请求顺序解析 source，并拒绝不存在的配置", () => {
    const sources = [source("src_a"), source("src_b")];
    expect(resolveCohortSources(sources, ["src_b", "src_a"])).toEqual([sources[1], sources[0]]);
    expect(() => resolveCohortSources(sources, ["src_missing"])).toThrow("src_missing");
  });

  it("保持串行顺序，以生产 collector 实现作为唯一执行路径", async () => {
    const calls: string[] = [];
    const db = {} as never;
    const results = await collectCohort(db, [source("src_a"), source("src_b")], async (_db, current) => {
      calls.push(current.id);
      return { runId: current.id, fetched: 1, inserted: 1, updated: 0, skipped: 0 };
    });

    expect(calls).toEqual(["src_a", "src_b"]);
    expect(results.map((entry) => entry.source_id)).toEqual(["src_a", "src_b"]);
  });

  it("只允许指定隔离根中的 DB 与原文目录，并拒绝默认 .data", () => {
    expect(resolveIsolatedCohortPaths({
      EVAL_ISOLATED_ROOT: "/tmp/insight-eval",
      DB_PATH: "/tmp/insight-eval/insight.db",
      DATA_DIR: "/tmp/insight-eval/data",
    }, "/workspace")).toEqual({
      isolatedRoot: "/tmp/insight-eval",
      dbPath: "/tmp/insight-eval/insight.db",
      dataDir: "/tmp/insight-eval/data",
    });

    expect(() => resolveIsolatedCohortPaths({
      EVAL_ISOLATED_ROOT: "/workspace/.data",
      DB_PATH: "/workspace/.data/insight.db",
      DATA_DIR: "/workspace/.data/raw",
    }, "/workspace")).toThrow("不得使用仓库默认 .data");
    expect(() => resolveIsolatedCohortPaths({
      EVAL_ISOLATED_ROOT: "/tmp/insight-eval",
      DB_PATH: "/tmp/other/insight.db",
      DATA_DIR: "/tmp/insight-eval/data",
    }, "/workspace")).toThrow("必须位于 EVAL_ISOLATED_ROOT 内");
  });
});
