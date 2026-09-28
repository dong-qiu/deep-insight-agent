/** B4 preflight: aggregate-only, read-only impact sample from a static SQLite backup.
 * No source text, URL, title, entity name or ID is printed. This is a diagnostic, not a reader gate. */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const safeBasis = new Set([
  "系统重要性判断：该结果可为工程选型提供参考。",
  "系统重要性判断：该结果可为安全审查提供参考。",
  "系统重要性判断：该结果可为评测解读提供参考。",
  "系统重要性判断：该结果可为研究跟踪提供参考。",
]);
const compareKey = (value) => value.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟「」『』]/g, '"')
  .replace(/[–—−]/g, "-").replace(/…/g, "...").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const codePoint = (n) => n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
// Keep this measurement copy byte-equivalent to sources/normalize.ts; product code imports it.
const normalizeBody = (body) => body
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|ul|ol|blockquote|section|article|table|thead|tbody|figure|figcaption|pre|hr)\b[^>]*>/gi, "\n")
  .replace(/<\/?[a-zA-Z][^>]*>/g, "")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lsquo;/gi, "‘").replace(/&rsquo;/gi, "’").replace(/&ldquo;/gi, "“").replace(/&rdquo;/gi, "”")
  .replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—").replace(/&hellip;/gi, "…")
  .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => codePoint(parseInt(n, 16)))
  .replace(/\s+/g, " ").trim();

function isCurrentV6(row) {
  let decision;
  try { decision = JSON.parse(row.decision); } catch { return false; }
  if (row.gate_version !== "display-coverage-v6" || row.statement !== row.quote
    || row.headline?.trim() || !safeBasis.has(row.importance_basis)
    || !Number.isInteger(row.statement_citation_index) || row.statement_citation_index < 1
    || !row.citation_ref || decision?.statement_citation_index !== row.statement_citation_index
    || decision?.statement_citation_ref !== row.citation_ref
    || decision?.display_projection_version !== "source_quote_v1"
    || decision?.statement_sha256 !== hash(row.statement) || decision?.quote_sha256 !== hash(row.quote)) return false;
  const factual = decision.claims?.filter((claim) => claim?.kind === "factual");
  if (!Array.isArray(factual) || !factual.length || factual.some((claim) => claim.supports !== true
    || !Array.isArray(claim.citation_indexes) || !claim.citation_indexes.length
    || claim.citation_indexes.some((index) => !Number.isInteger(index) || index < 1))) return false;
  if (!factual.some((claim) => claim.citation_indexes.includes(row.statement_citation_index))) return false;
  const statement = factual.filter((claim) => claim.claim_id === "statement:1" && claim.field === "statement");
  return statement.length === 1 && statement[0].citation_indexes.length === 1
    && statement[0].citation_indexes[0] === row.statement_citation_index
    && statement[0].countercheck?.supports === true;
}

function staticSnapshot(name) {
  if (!name || !path.isAbsolute(name)) throw new Error("B4_SNAPSHOT_DB_PATH must be an absolute static backup");
  const resolved = fs.realpathSync(name);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || fs.existsSync(`${resolved}-wal`) || fs.existsSync(`${resolved}-shm`)) {
    throw new Error("snapshot must be a standalone file without WAL/SHM");
  }
  const active = path.resolve(process.env.B4_ACTIVE_DB_PATH || "/data/insight.db");
  if (fs.existsSync(active)) {
    const current = fs.statSync(active);
    if (fs.realpathSync(active) === resolved || (current.dev === stat.dev && current.ino === stat.ino)) {
      throw new Error("refusing active SQLite database");
    }
  }
  process.env.SQLITE_USE_URI = "1";
  const db = new Database(`${pathToFileURL(resolved).href}?mode=ro&immutable=1`, { readonly: true, fileMustExist: true });
  db.pragma("query_only=ON");
  return db;
}

const BASE = `FROM insight i
  JOIN analysis_batch b ON b.id=i.batch_id
  JOIN display_coverage_audit d ON d.batch_id=b.id AND d.insight_id=i.id
    AND d.terminal_reason IN ('kept','kept_degraded')
  JOIN citation c ON c.insight_id=i.id AND c.citation_index=i.statement_citation_index-1
  JOIN citation_check cc ON cc.batch_id=b.id AND cc.insight_id=i.id AND cc.citation_index=c.citation_index
  LEFT JOIN content_item ci ON ci.id=c.content_item_id
  WHERE b.status='done' AND b.display_coverage_state='audited'
    AND b.display_projection_version='source_quote_v1'
    AND cc.reachability='pass' AND cc.consistency='support' AND cc.verdict='pass'`;
const COLS = `i.id AS insight_id,i.topic_id,i.statement,i.entities,i.statement_citation_index,i.headline,i.importance_basis,
  c.citation_ref,c.quote,c.content_item_id,d.gate_version,d.decision,
  ci.id AS content_id,ci.raw_ref,ci.reader_eligible,ci.body,ci.body_kind,ci.content_hash`;

// Approximate the graph shape for early preflight. This local copy does not reproduce every
// production canonicalization/tie case; the final graph counts come from the bundled actual
// reader functions in b4-reader-path-impact.cjs. Names are never written to output.
function graphCounts(rows) {
  const alias = (name) => name === "Sakana AI" ? "Sakana" : name;
  const norm = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const entities = rows.map((row) => {
    let all;
    try { all = JSON.parse(row.entities || "[]"); } catch { return []; }
    if (!Array.isArray(all)) return [];
    return all.filter((entity) => {
      const name = entity?.name?.trim();
      if (!name) return false;
      if (!/^[\x20-\x7e]+$/.test(name) || !/[a-z0-9]/i.test(name)) return row.statement.includes(name);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "iu").test(row.statement);
    });
  });
  const frequency = new Map();
  for (const group of entities) for (const item of group) {
    const name = alias(item.name.trim());
    frequency.set(name, (frequency.get(name) || 0) + 1);
  }
  const byKey = new Map();
  for (const [name, count] of frequency) {
    const key = norm(name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push([name, count]);
  }
  const display = new Map();
  for (const [key, group] of byKey) {
    group.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    display.set(key, group[0][0]);
  }
  const canon = (name) => display.get(norm(alias(name.trim()))) || alias(name.trim());
  const mentions = new Map();
  const pairWeights = new Map();
  for (const group of entities) {
    const names = [...new Set(group.map((item) => canon(item.name)).filter(Boolean))];
    for (const name of names) mentions.set(name, (mentions.get(name) || 0) + 1);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const pair = JSON.stringify(names[i] < names[j] ? [names[i], names[j]] : [names[j], names[i]]);
      pairWeights.set(pair, (pairWeights.get(pair) || 0) + 1);
    }
  }
  const top = [...mentions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name]) => name);
  const selected = new Set(top);
  const edges = [...pairWeights].filter(([key]) => JSON.parse(key).every((name) => selected.has(name)));
  let threshold = 8;
  for (let weight = 2; weight < 8; weight++) if (edges.filter(([, count]) => count >= weight).length <= 60) {
    threshold = weight; break;
  }
  const defaultEdges = edges.filter(([, count]) => count >= threshold);
  const connected = new Set(defaultEdges.flatMap(([key]) => JSON.parse(key)));
  return { with_entities: entities.filter((group) => group.length > 0).length,
    candidate_nodes: top.length, candidate_edges: edges.length,
    default_threshold: threshold, default_nodes: connected.size, default_edges: defaultEdges.length,
    node_drill_occurrences: top.reduce((sum, name) => sum + mentions.get(name), 0),
    candidate_edge_drill_occurrences: edges.reduce((sum, [, count]) => sum + count, 0),
    default_edge_drill_occurrences: defaultEdges.reduce((sum, [, count]) => sum + count, 0) };
}

function classifier(db, rawRoot) {
  const effects = db.prepare(`SELECT status,idempotency_key,artifact_manifest FROM generation_effect
    WHERE kind='raw_archive' AND raw_content_id=?`);
  const root = fs.realpathSync(rawRoot);
  let readBytes = 0;
  function check(row) {
    if (!row.content_id) return "missing_content";
    if (row.reader_eligible !== 1) return "pending_content";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.content_id)
      || typeof row.body !== "string" || !row.body.trim()
      || !["article", "show_notes", "transcript"].includes(row.body_kind)
      || typeof row.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.content_hash)
      || hash(normalizeBody(row.body)) !== row.content_hash) return "body_hash_mismatch";
    const matches = [];
    for (const effect of effects.all(row.content_id)) {
      let manifest;
      try { manifest = JSON.parse(effect.artifact_manifest); } catch { continue; }
      if (!Array.isArray(manifest) || manifest.length !== 1) continue;
      const artifact = manifest[0];
      if (typeof artifact?.target !== "string" || !/^[A-Za-z0-9_-]{1,128}\.[a-f0-9]{64}\.txt$/.test(artifact.target)
        || artifact.target !== `${row.content_id}.${artifact.sha256}.txt`
        || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || row.raw_ref !== `raw/${artifact.target}`
        || effect.idempotency_key !== `raw_archive:${row.content_id}:${artifact.sha256}`) continue;
      matches.push({ effect, artifact });
    }
    if (matches.length !== 1) return matches.length ? "ambiguous_effect" : "no_exact_effect";
    const { effect, artifact } = matches[0];
    if (effect.status !== "committed") return "not_committed";
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) return "invalid_manifest";
    let bytes;
    try {
      const file = path.join(root, artifact.target);
      if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) return "unreadable_archive";
      bytes = fs.readFileSync(file);
    } catch { return "unreadable_archive"; }
    readBytes += bytes.length;
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) return "archive_hash_mismatch";
    let envelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { return "plain_archive"; }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || envelope.schema_version !== "content-raw-archive-v1") return "plain_archive";
    const allowedKeys = new Set(["schema_version", "source_body_origin", "source_body", "source_body_kind",
      "source_item_raw", "article_html", "structured_body_sha256"]);
    if (typeof envelope.source_body !== "string" || typeof envelope.structured_body_sha256 !== "string"
      || typeof envelope.source_item_raw !== "string"
      || !["feed", "article_page", "transcript"].includes(envelope.source_body_origin)
      || (envelope.source_body_origin === "article_page" ? typeof envelope.article_html !== "string"
        : Object.hasOwn(envelope, "article_html"))
      || (envelope.source_body_origin === "transcript") !== (row.body_kind === "transcript")
      || Object.keys(envelope).some((key) => !allowedKeys.has(key))) return "invalid_v1_envelope";
    if (envelope.structured_body_sha256 !== row.content_hash) {
      return "body_hash_mismatch";
    }
    const reconstructed = normalizeBody(envelope.source_body).slice(0, row.body_kind === "transcript" ? 300000 : 50000);
    if (envelope.source_body_kind !== row.body_kind || reconstructed !== row.body) return "envelope_body_mismatch";
    return "v1_valid";
  }
  return { check, readBytes: () => readBytes };
}

// The archive/body binding is shared by a content item, but quote reachability belongs to each
// citation. Caching the latter by content ID lets a stale quote inherit another citation's pass.
function createCategorizer(verifier) {
  const byContent = new Map();
  function category(row) {
    const key = row.content_item_id;
    if (!byContent.has(key)) byContent.set(key, verifier.check(row));
    const source = byContent.get(key);
    if (source !== "v1_valid") return source;
    return typeof row.quote === "string" && row.quote.trim()
      && compareKey(row.body).includes(compareKey(row.quote))
      ? "v1_valid" : "quote_missing_from_current_body";
  }
  return { category, byContent };
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.ceil(q * sorted.length) - 1] || 0) * 100) / 100;
}

function run() {
  const db = staticSnapshot(process.env.B4_SNAPSHOT_DB_PATH);
  if (!process.env.B4_RAW_ROOT || !path.isAbsolute(process.env.B4_RAW_ROOT)) throw new Error("B4_RAW_ROOT required");
  const graphRows = db.prepare(`SELECT ${COLS} ${BASE} ORDER BY i.topic_id,i.rowid`).all();
  const leadRows = db.prepare(`SELECT e.lead_id,l.status AS lead_status,t.* FROM (SELECT ${COLS} ${BASE}) t
    JOIN tech_lead_evidence e ON e.insight_id=t.insight_id AND e.citation_index=t.statement_citation_index-1
    JOIN tech_lead l ON l.id=e.lead_id
    JOIN content_item ci2 ON ci2.id=t.content_item_id AND ci2.reader_eligible=1
    JOIN source s ON s.id=ci2.source_id ORDER BY e.lead_id,t.insight_id`).all();
  const graph = graphRows.filter(isCurrentV6);
  const leads = leadRows.filter(isCurrentV6);
  const all = [...graph, ...leads];
  const verifier = classifier(db, process.env.B4_RAW_ROOT);
  const { category, byContent } = createCategorizer(verifier);
  const start = performance.now();
  for (const row of all) category(row);
  const elapsed = performance.now() - start;
  const oldLeadIds = new Set(leads.map((row) => row.lead_id));
  const newLeadIds = new Set(leads.filter((row) => category(row) === "v1_valid").map((row) => row.lead_id));
  const oldDefaultLeadIds = new Set(leads.filter((row) => row.lead_status !== "dismissed").map((row) => row.lead_id));
  const newDefaultLeadIds = new Set(leads.filter((row) => row.lead_status !== "dismissed" && category(row) === "v1_valid").map((row) => row.lead_id));
  const opportunityIds = (leadIds, defaultOnly = false) => {
    if (!leadIds.size) return 0;
    const sql = db.prepare(`SELECT DISTINCT ol.opportunity_id FROM opportunity_lead ol
      JOIN technology_opportunity o ON o.id=ol.opportunity_id
      WHERE ol.lead_id=?${defaultOnly ? " AND o.status NOT IN ('rejected','archived')" : ""}`);
    const ids = new Set();
    for (const leadId of leadIds) for (const row of sql.all(leadId)) ids.add(row.opportunity_id);
    return ids.size;
  };
  const opportunityEvidenceRows = (defaultOnly = false) => {
    const counts = new Map();
    for (const row of leads) {
      const current = counts.get(row.lead_id) || { before: 0, after: 0 };
      current.before++;
      if (category(row) === "v1_valid") current.after++;
      counts.set(row.lead_id, current);
    }
    const links = db.prepare(`SELECT ol.lead_id FROM opportunity_lead ol JOIN technology_opportunity o ON o.id=ol.opportunity_id
      ${defaultOnly ? "WHERE o.status NOT IN ('rejected','archived')" : ""}`).all();
    return links.reduce((sum, link) => {
      const count = counts.get(link.lead_id);
      return { before: sum.before + (count?.before || 0), after: sum.after + (count?.after || 0) };
    }, { before: 0, after: 0 });
  };
  const topics = [...new Set(graph.map((row) => row.topic_id))].sort().map((topic_id) => {
    const rows = graph.filter((row) => row.topic_id === topic_id);
    const categories = {};
    for (const row of rows) categories[category(row)] = (categories[category(row)] || 0) + 1;
    return { topic_id, current_insights: rows.length,
      after: rows.filter((row) => category(row) === "v1_valid").length,
      categories,
      before_graph_estimate: graphCounts(rows),
      after_graph_estimate: graphCounts(rows.filter((row) => category(row) === "v1_valid")) };
  });
  const contentCategories = {};
  for (const value of byContent.values()) contentCategories[value] = (contentCategories[value] || 0) + 1;
  const warm = [];
  const oldRead = [];
  const newRead = [];
  for (let i = 0; i < 30; i++) {
    let t = performance.now();
    const oldGraph = db.prepare(`SELECT ${COLS} ${BASE} ORDER BY i.topic_id,i.rowid`).all().filter(isCurrentV6);
    const oldLeads = db.prepare(`SELECT e.lead_id,l.status AS lead_status,t.* FROM (SELECT ${COLS} ${BASE}) t
      JOIN tech_lead_evidence e ON e.insight_id=t.insight_id AND e.citation_index=t.statement_citation_index-1
      JOIN tech_lead l ON l.id=e.lead_id
      JOIN content_item ci2 ON ci2.id=t.content_item_id AND ci2.reader_eligible=1
      JOIN source s ON s.id=ci2.source_id ORDER BY e.lead_id,t.insight_id`).all().filter(isCurrentV6);
    oldRead.push(performance.now() - t);
    t = performance.now();
    const full = createCategorizer(classifier(db, process.env.B4_RAW_ROOT));
    for (const row of [...oldGraph, ...oldLeads]) full.category(row);
    newRead.push(performance.now() - t + oldRead[i]);
    t = performance.now();
    const verify = createCategorizer(classifier(db, process.env.B4_RAW_ROOT));
    for (const row of all) verify.category(row);
    warm.push(performance.now() - t);
  }
  console.log(JSON.stringify({ snapshot: path.basename(path.dirname(process.env.B4_SNAPSHOT_DB_PATH)),
    graph: topics, leads: { all_current: oldLeadIds.size, all_after: newLeadIds.size,
      default_current: oldDefaultLeadIds.size, default_after: newDefaultLeadIds.size },
    opportunities: { all_current: opportunityIds(oldLeadIds), all_after: opportunityIds(newLeadIds),
      default_current: opportunityIds(oldLeadIds, true), default_after: opportunityIds(newLeadIds, true) },
    opportunity_evidence_rows: { all: opportunityEvidenceRows(), default: opportunityEvidenceRows(true) },
    unique_content_count: byContent.size, content_categories: contentCategories,
    first_pass_read_bytes: verifier.readBytes(), first_pass_ms: Math.round(elapsed * 100) / 100,
    warm_verification_p50_ms: percentile(warm, 0.5), warm_verification_p95_ms: percentile(warm, 0.95),
    baseline_db_audit_p50_ms: percentile(oldRead, 0.5), baseline_db_audit_p95_ms: percentile(oldRead, 0.95),
    new_db_audit_archive_p50_ms: percentile(newRead, 0.5), new_db_audit_archive_p95_ms: percentile(newRead, 0.95),
    caveat: "read-side replica on static backup; includes audit SQL and archive checks, excludes graph layout/Next.js render" }));
  db.close();
}

if (require.main === module || process.argv.length === 1) run(); // Also support read-only SSM stdin execution.
module.exports = { isCurrentV6, staticSnapshot, classifier, createCategorizer, graphCounts };
