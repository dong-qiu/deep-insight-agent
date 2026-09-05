/**
 * Relative P95 gate for the committed report-reader snapshot.
 *
 * The baseline and current reader run against the same synthetic P0c-sized
 * dataset, process, SQLite connection, report artifacts, warm-up, and sample
 * count. This deliberately measures only already-committed report snapshots:
 * no queue, checker, anchor, dashboard, or writer path participates.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/lib/db/index.js";
import { P0C_READER_BASELINE_COMMIT, getP0cBaselineReport } from "../src/lib/db/report-reader-p0c-baseline.v2.js";
import { applyProvenanceMigrations } from "../src/lib/db/provenance-migrations.js";
import { insertTopic } from "../src/lib/db/repos.js";
import { getReport } from "../src/lib/db/reports.js";

interface P0cFixture { traces: number; database_target_bytes?: number; }
interface Fixture {
  version: number;
  p0c_fixture: string;
  p0c_fixture_sha256: string;
  baseline_commit: string;
  warmup_samples: number;
  measurement_samples: number;
  operations_per_sample: number;
  report_body_bytes: number;
}

const argument = process.argv.find((value) => value.startsWith("--fixture="));
const fixturePath = argument?.slice("--fixture=".length) ?? "./report-reader-p0c-fixture.v2.json";
const fixture = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), "utf8")) as Fixture;
const p0cPath = join(fileURLToPath(new URL(".", import.meta.url)), fixture.p0c_fixture);
const p0cBytes = readFileSync(p0cPath);
const p0c = JSON.parse(p0cBytes.toString("utf8")) as P0cFixture;

function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function validateFixture(): void {
  if (fixture.version !== 2 || !positiveInteger(fixture.warmup_samples) || !positiveInteger(fixture.measurement_samples)
    || !positiveInteger(fixture.operations_per_sample) || !positiveInteger(fixture.report_body_bytes) || !positiveInteger(p0c.traces)
    || createHash("sha256").update(p0cBytes).digest("hex") !== fixture.p0c_fixture_sha256
    || fixture.baseline_commit !== P0C_READER_BASELINE_COMMIT) throw new Error("invalid_report_reader_p0c_fixture");
}
validateFixture();

function percentile(samples: number[], percentileValue: number): number {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * percentileValue) - 1] ?? 0;
}
function measure(reader: () => unknown): number {
  const started = performance.now();
  for (let operation = 0; operation < fixture.operations_per_sample; operation += 1) {
    if (!reader()) throw new Error("committed_report_snapshot_not_readable");
  }
  return (performance.now() - started) / fixture.operations_per_sample;
}

const directory = mkdtempSync(join(tmpdir(), "insight-report-reader-p0c-"));
try {
  const dbPath = join(directory, "fixture.db");
  const artifactDirectory = join(directory, "reports");
  const db = openDb(dbPath);
  applyProvenanceMigrations(db);
  mkdirSync(artifactDirectory, { recursive: true });
  for (let index = 0; index < 4; index += 1) insertTopic(db, {
    id: `p0c-topic-${index}`, name: `P0c topic ${index}`, keywords: [], facets: [], language: "en", brief_schedule: "daily", enabled: true,
  });
  const body = "x".repeat(fixture.report_body_bytes);
  const insert = db.prepare(`INSERT INTO report
    (id,type,topic_id,status,generated_at,title,body_path,insight_ids,event_ids,prev_report_id,citation_count,cost,failure)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
  for (let index = 0; index < p0c.traces; index += 1) {
    const id = `p0c-report-${index}`;
    const prefix = join(artifactDirectory, id);
    writeFileSync(`${prefix}.md`, `# ${id}\n${body}`);
    writeFileSync(`${prefix}.html`, `<h1>${id}</h1><p>${body}</p>`);
    insert.run(id, "brief", `p0c-topic-${index % 4}`, "done", "2026-08-17T00:00:00.000Z", `P0c report ${index}`, prefix, "[]", "[]", null, 0, '{"tokens":0,"amount":0}');
  }
  if (p0c.database_target_bytes) {
    db.exec("CREATE TABLE benchmark_padding (payload BLOB NOT NULL)");
    const pad = db.prepare("INSERT INTO benchmark_padding(payload) VALUES (zeroblob(?))");
    db.pragma("wal_checkpoint(TRUNCATE)");
    while (statSync(dbPath).size < p0c.database_target_bytes) {
      pad.run(Math.min(4 * 1024 * 1024, p0c.database_target_bytes - statSync(dbPath).size));
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
  }
  const reportId = "p0c-report-0";
  const baselineReader = () => getP0cBaselineReport(db, reportId);
  const currentReader = () => getReport(db, reportId);
  for (let index = 0; index < fixture.warmup_samples; index += 1) {
    for (let operation = 0; operation < fixture.operations_per_sample; operation += 1) { baselineReader(); currentReader(); }
  }
  const baseline = [] as number[];
  const current = [] as number[];
  for (let index = 0; index < fixture.measurement_samples; index += 1) {
    // Alternate first reader to avoid giving either implementation a systematic cache advantage.
    if (index % 2 === 0) { baseline.push(measure(baselineReader)); current.push(measure(currentReader)); }
    else { current.push(measure(currentReader)); baseline.push(measure(baselineReader)); }
  }
  const baselineP95 = percentile(baseline, 0.95);
  const currentP95 = percentile(current, 0.95);
  const result = {
    benchmark_version: "report-reader-p0c-v2",
    baseline: { commit: fixture.baseline_commit, reader: "getReport", p95_ms: baselineP95, samples_ms: baseline },
    current: { commit: process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? "local-worktree", reader: "getReport", p95_ms: currentP95, samples_ms: current },
    allowed_regression_ratio: 1.05,
    allowed_current_p95_ms: baselineP95 * 1.05,
    passed: currentP95 <= baselineP95 * 1.05,
    dataset: { p0c_fixture: fixture.p0c_fixture, p0c_fixture_sha256: fixture.p0c_fixture_sha256, p0c_trace_count: p0c.traces, report_snapshot_count: p0c.traces, report_body_bytes: fixture.report_body_bytes },
    execution_environment: { node: process.version, sqlite: (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cpu_count: cpus().length },
    warmup_samples: fixture.warmup_samples,
    measurement_samples: fixture.measurement_samples,
    operations_per_sample: fixture.operations_per_sample,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--enforce") && !result.passed) process.exitCode = 1;
  db.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
