/** B4 preflight: run old and new production reader functions against one immutable backup.
 * Emit only aggregate counts, digests, read-byte totals and timings; never print source data. */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");

const snapshot = process.env.B4_SNAPSHOT_DB_PATH;
const rawRoot = process.env.B4_RAW_ROOT;
const oldBundle = process.env.B4_OLD_BUNDLE;
const newBundle = process.env.B4_NEW_BUNDLE;
const asOf = process.env.B4_SNAPSHOT_AS_OF;
const rounds = Number(process.env.B4_ROUNDS || "30");
if (!snapshot || !path.isAbsolute(snapshot) || !rawRoot || !path.isAbsolute(rawRoot)
  || !oldBundle || !path.isAbsolute(oldBundle) || !newBundle || !path.isAbsolute(newBundle)
  || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(asOf || "")
  || !Number.isSafeInteger(rounds) || rounds < 20 || rounds > 100) {
  throw new Error("absolute static snapshot/raw/bundle paths, UTC as-of and 20-100 rounds required");
}
const dbPath = fs.realpathSync(snapshot);
const dbStat = fs.statSync(dbPath);
if (!dbStat.isFile() || fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`)) {
  throw new Error("snapshot must be a standalone SQLite backup without sidecars");
}
const activePath = path.resolve(process.env.B4_ACTIVE_DB_PATH || "/data/insight.db");
if (fs.existsSync(activePath)) {
  const activeStat = fs.statSync(activePath);
  if (fs.realpathSync(activePath) === dbPath || (activeStat.dev === dbStat.dev && activeStat.ino === dbStat.ino)) {
    throw new Error("refusing active SQLite database");
  }
}
const resolvedRaw = fs.realpathSync(rawRoot);
process.env.DATA_DIR = path.dirname(resolvedRaw);
process.env.SQLITE_USE_URI = "1";
let archiveReadBytes = 0;
const rawDescriptors = new Set();
const originalOpen = fs.openSync;
const originalRead = fs.readFileSync;
const originalClose = fs.closeSync;
fs.openSync = function (target, ...args) {
  const fd = originalOpen.call(fs, target, ...args);
  if (typeof target === "string" && target.startsWith(`${resolvedRaw}${path.sep}`)) rawDescriptors.add(fd);
  return fd;
};
fs.readFileSync = function (target, ...args) {
  const value = originalRead.call(fs, target, ...args);
  if (typeof target === "number" && rawDescriptors.has(target)) {
    archiveReadBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
  }
  return value;
};
fs.closeSync = function (fd, ...args) {
  rawDescriptors.delete(fd);
  return originalClose.call(fs, fd, ...args);
};
syncBuiltinESMExports();

const old = require(oldBundle);
const current = require(newBundle);
const db = new Database(`${pathToFileURL(dbPath).href}?mode=ro&immutable=1`, { readonly: true, fileMustExist: true });
db.pragma("query_only=ON");
const topicIds = db.prepare("SELECT id FROM topic ORDER BY id").all().map((row) => row.id);

const hashSet = (items) => createHash("sha256").update([...items].sort().join("\n")).digest("hex");
const percentile = (values, q) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(q * ordered.length) - 1] * 100) / 100;
};
const intersectDiff = (before, after) => ({
  before_items: before.size,
  after_items: after.size,
  removed: [...before].filter((item) => !after.has(item)).length,
  added: [...after].filter((item) => !before.has(item)).length,
  before_sha256: hashSet(before),
  after_sha256: hashSet(after),
});
const context = (api) => api.createReaderEvidenceContext?.(db);

function graphData(api) {
  api.listTopics(db);
  return new Map(topicIds.map((topicId) => [topicId, api.buildTopicGraphData(db, topicId)]));
}
function drillItems(api, topicId, a, b) {
  const insights = b ? api.insightsCooccurring(db, topicId, a, b)
    : api.insightsMentioningEntity(db, topicId, a);
  const items = api.groupDrillInsights(insights, api.reportLinksByInsight(db, topicId));
  JSON.stringify({ items }); // Include the route's response serialization, excluding Next.js/network.
  return items;
}
function drillMembers(items, prefix) {
  const output = new Set();
  for (const group of items) {
    output.add(`${prefix}:g:${group.id}:${group.occurrence_count}`);
    for (const occurrence of group.occurrences) {
      output.add(`${prefix}:i:${occurrence.id}`);
      for (const link of occurrence.report_links) output.add(`${prefix}:r:${occurrence.id}:${link.report_id}`);
    }
  }
  return output;
}
function graphBreakdown(api) {
  return [...graphData(api)].map(([topic_id, graph]) => {
    const visibleEdges = graph.candidateEdges.filter((edge) => edge.weight >= graph.suggestedMinWeight);
    const connected = new Set(visibleEdges.flatMap((edge) => [edge.a, edge.b]));
    return { topic_id, insights: graph.insightCount, with_entities: graph.withEntities,
      candidate_nodes: graph.nodes.length, candidate_edges: graph.candidateEdges.length,
      default_threshold: graph.suggestedMinWeight,
      default_nodes: graph.nodes.filter((node) => connected.has(node.name)).length,
      default_edges: visibleEdges.length,
      node_drill_occurrences: graph.nodes.reduce((sum, node) => sum + node.mentions, 0),
      candidate_edge_drill_occurrences: graph.candidateEdges.reduce((sum, edge) => sum + edge.weight, 0),
      default_edge_drill_occurrences: visibleEdges.reduce((sum, edge) => sum + edge.weight, 0) };
  });
}
const baselineGraphs = graphData(old);
const nodes = [...baselineGraphs].flatMap(([topicId, graph]) => graph.nodes.slice(0, 3)
  .map((node) => ({ topicId, name: node.name })));
const edges = [...baselineGraphs].flatMap(([topicId, graph]) => graph.candidateEdges.slice(0, 3)
  .map((edge) => ({ topicId, a: edge.a, b: edge.b })));
const recentSince = new Date(Date.parse(asOf) - 48 * 3_600_000).toISOString();
const baselineLeads = old.listTechLeads(db, { since: recentSince });
const baselineOpportunities = old.listTechnologyOpportunities(db);
const leadIds = baselineLeads.slice(0, 5).map((lead) => lead.id);
const opportunityIds = baselineOpportunities.slice(0, 5).map((opportunity) => opportunity.id);

const cases = {
  graph(api) {
    const output = new Set();
    for (const [topicId, graph] of graphData(api)) {
      for (const node of graph.nodes) output.add(`n:${topicId}:${node.name}:${node.type}:${node.mentions}`);
      for (const edge of graph.candidateEdges) output.add(`e:${topicId}:${edge.a}:${edge.b}:${edge.weight}:${edge.strength}`);
    }
    return output;
  },
  node_drill(api) {
    const output = new Set();
    nodes.forEach(({ topicId, name }, index) => {
      for (const item of drillMembers(drillItems(api, topicId, name), index)) output.add(item);
    });
    return output;
  },
  edge_drill(api) {
    const output = new Set();
    edges.forEach(({ topicId, a, b }, index) => {
      for (const item of drillMembers(drillItems(api, topicId, a, b), index)) output.add(item);
    });
    return output;
  },
  lead_list(api) {
    const evidence = context(api);
    const output = new Set();
    api.listTopics(db);
    for (const lead of api.listTechLeads(db, { since: recentSince }, evidence)) {
      output.add(`l:${lead.id}`);
      for (const item of api.listTechLeadEvidence(db, lead.id, evidence)) {
        output.add(`e:${lead.id}:${item.insight_id}:${item.citation_index}`);
      }
    }
    return output;
  },
  lead_detail(api) {
    const evidence = context(api);
    const output = new Set();
    for (const id of leadIds) {
      const lead = api.getTechLead(db, id, evidence);
      if (!lead) continue;
      output.add(`l:${id}`);
      for (const item of api.listTechLeadEvidence(db, id, evidence)) {
        output.add(`e:${id}:${item.insight_id}:${item.citation_index}`);
      }
    }
    return output;
  },
  opportunity_list(api) {
    const evidence = context(api);
    const output = new Set();
    api.listTopics(db);
    api.listTopicDirections(db, { includeRetired: false });
    const metrics = new Map();
    for (const opportunity of api.listTechnologyOpportunities(db, { includeClosed: true, limit: 1000 }, evidence)) {
      if (!opportunity.direction_id) continue;
      const metric = metrics.get(opportunity.direction_id) || { opportunities: 0, stale: 0 };
      metric.opportunities++;
      if (opportunity.mapping_state === "stale") metric.stale++;
      metrics.set(opportunity.direction_id, metric);
    }
    for (const [directionId, metric] of metrics) {
      output.add(`m:${directionId}:${metric.opportunities}:${metric.stale}`);
    }
    for (const opportunity of api.listTechnologyOpportunities(db, {}, evidence)) {
      output.add(`o:${opportunity.id}`);
      for (const lead of api.listOpportunityLeads(db, opportunity.id, evidence)) {
        output.add(`l:${opportunity.id}:${lead.id}`);
        for (const item of api.listTechLeadEvidence(db, lead.id, evidence)) {
          output.add(`e:${opportunity.id}:${lead.id}:${item.insight_id}:${item.citation_index}`);
        }
      }
    }
    return output;
  },
  opportunity_detail(api) {
    const evidence = context(api);
    const output = new Set();
    for (const id of opportunityIds) {
      const opportunity = api.getTechnologyOpportunity(db, id, evidence);
      if (!opportunity) continue;
      output.add(`o:${id}`);
      for (const lead of api.listOpportunityLeads(db, id, evidence)) {
        output.add(`l:${id}:${lead.id}`);
        for (const item of api.listTechLeadEvidence(db, lead.id, evidence)) {
          output.add(`e:${id}:${lead.id}:${item.insight_id}:${item.citation_index}`);
        }
      }
    }
    return output;
  },
};

// A graph page opens one topic, and a node/edge click opens one drill. Time each request shape
// separately; timing nine drills as one batch would make the 250 ms per-read budget meaningless.
const perRequest = {
  graph: topicIds.map((topicId) => (api) => {
    api.listTopics(db);
    const graph = api.buildTopicGraphData(db, topicId);
    return new Set([...graph.nodes.map((node) => `n:${node.name}:${node.type}:${node.mentions}`),
      ...graph.candidateEdges.map((edge) => `e:${edge.a}:${edge.b}:${edge.weight}:${edge.strength}`)]);
  }),
  node_drill: nodes.map(({ topicId, name }) => (api) => drillMembers(drillItems(api, topicId, name))),
  edge_drill: edges.map(({ topicId, a, b }) => (api) => drillMembers(drillItems(api, topicId, a, b))),
  lead_list: [cases.lead_list],
  lead_detail: leadIds.map((id) => (api) => {
    const evidence = context(api);
    const lead = api.getTechLead(db, id, evidence);
    return new Set(lead ? [`l:${id}`, ...api.listTechLeadEvidence(db, id, evidence)
      .map((item) => `e:${item.insight_id}:${item.citation_index}`)] : []);
  }),
  opportunity_list: [cases.opportunity_list],
  opportunity_detail: opportunityIds.map((id) => (api) => {
    const evidence = context(api);
    const opportunity = api.getTechnologyOpportunity(db, id, evidence);
    if (!opportunity) return new Set();
    const output = new Set([`o:${id}`]);
    for (const lead of api.listOpportunityLeads(db, id, evidence)) {
      output.add(`l:${lead.id}`);
      for (const item of api.listTechLeadEvidence(db, lead.id, evidence)) {
        output.add(`e:${lead.id}:${item.insight_id}:${item.citation_index}`);
      }
    }
    return output;
  }),
};

function measure(api, fn) {
  fn(api); // warm query plan and filesystem cache, then time complete reader calls.
  const elapsed = [];
  const bytes = [];
  let result;
  for (let i = 0; i < rounds; i++) {
    archiveReadBytes = 0;
    const start = performance.now();
    const output = fn(api);
    elapsed.push(performance.now() - start);
    bytes.push(archiveReadBytes);
    if (result && hashSet(result) !== hashSet(output)) throw new Error("reader output changed during static-snapshot sample");
    result = output;
  }
  return { output: result, p50_ms: percentile(elapsed, 0.5), p95_ms: percentile(elapsed, 0.95),
    p50_raw_bytes: percentile(bytes, 0.5), p95_raw_bytes: percentile(bytes, 0.95) };
}

try {
  const paths = {};
  for (const [name, fn] of Object.entries(cases)) {
    const beforeOutput = fn(old);
    const afterOutput = fn(current);
    const units = perRequest[name];
    const before = units.map((unit) => measure(old, unit));
    const after = units.map((unit) => measure(current, unit));
    const summary = (samples) => samples.length ? {
      median_request_p50_ms: percentile(samples.map((item) => item.p50_ms), 0.5),
      worst_request_p95_ms: Math.max(...samples.map((item) => item.p95_ms)),
      request_p95_ms: samples.map((item) => item.p95_ms),
      total_sampled_raw_bytes: samples.reduce((sum, item) => sum + item.p50_raw_bytes, 0),
      max_request_raw_bytes: Math.max(...samples.map((item) => item.p95_raw_bytes)),
    } : null;
    paths[name] = { ...intersectDiff(beforeOutput, afterOutput), sampled_requests: units.length,
      before: summary(before), after: summary(after) };
  }
  console.log(JSON.stringify({ snapshot: path.basename(path.dirname(dbPath)), baseline: "42e68fa",
    current_bundle_sha256: createHash("sha256").update(originalRead.call(fs, newBundle)).digest("hex"),
    rounds, sampled_nodes: nodes.length, sampled_edges: edges.length,
    sampled_leads: leadIds.length, sampled_opportunities: opportunityIds.length, paths,
    graph_breakdown: { before: graphBreakdown(old), after: graphBreakdown(current) },
    caveat: "non-admin DB reader sequences on one immutable snapshot, plus drill JSON serialization; excludes auth, Next.js render, network and browser layout" }));
} finally {
  db.close();
}
