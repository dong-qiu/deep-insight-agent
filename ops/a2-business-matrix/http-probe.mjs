import assert from "node:assert/strict";
import { connect } from "node:net";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { assertHttpPath, assertStatus, assertVisible, assertWriter, assertBusinessReady } from "./contracts.mjs";
import { dbAt, snapshot, hash, bundleIdentity, cases, leadId, insightId, topicId, reportIds, expectedLeads, expectedInsights } from "./in-image.mjs";

const phase = process.argv[2], observations = [];
async function request(path, { method = "GET", cookies, body, headers = {}, auth = false } = {}) {
  assertHttpPath(method, path);
  const response = await fetch(`http://127.0.0.1:3000${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { ...(cookies ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers }, body });
  if (cookies) for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0], at = pair.indexOf("=");
    if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await response.text();
  // Auth response bodies can contain credentials-derived tokens: never hash or serialize them.
  observations.push({ method, path: path.split("?", 1)[0], status: response.status, ...(auth ? {} : { body_sha256: hash(text) }) });
  return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })(), location: response.headers.get("location") };
}
const json = (path, cookies, body, method = "POST", headers = {}) => request(path, { cookies, method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
async function login(email, password, valid = true) {
  const cookies = new Map();
  const csrf = await request("/api/auth/csrf", { cookies, auth: true }); assertStatus(csrf.status, 200);
  const signed = await request("/api/auth/callback/credentials", { method: "POST", cookies, auth: true,
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.body.csrfToken, email, password, callbackUrl: "http://127.0.0.1:3000" }) });
  assert.ok([200, 302].includes(signed.status), "credentials route did not complete");
  const verified = await request("/api/reports", { cookies }); assertStatus(verified.status, valid ? 200 : 401);
  return cookies;
}
async function health() {
  const response = await request("/api/health");
  assertBusinessReady(response, { status: 200 }); return response;
}
async function waitReady() {
  for (let n = 0; n < 45; n++) {
    try { return await health(); } catch {
      if (n === 44) throw new Error("isolated Web app never ready");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
async function blockedNetwork() {
  const results = [];
  // Numeric addresses prove routing refusal, rather than relying on DNS alone.
  for (const [host, port, category] of [["1.1.1.1", 443, "external-https"], ["169.254.169.254", 80, "aws-metadata"]]) {
    const code = await new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      socket.on("connect", () => { socket.destroy(); reject(new Error("network isolation failed")); });
      socket.on("error", error => { socket.destroy(); resolve(error.code); });
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("network refusal must be observed, not assumed from timeout")); });
    });
    assert.ok(["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(code)); results.push({ category, address: host, port, result: code });
  }
  return results;
}
const db = dbAt();
const take = () => snapshot(db);
const viewerEmail = "viewer@a2.example.test";
const password = process.env.A2_VIEWER_PASSWORD;
assert.ok(password && process.env.ADMIN_PASSWORD && process.env.AUTH_SECRET);

await waitReady();
const network = await blockedNetwork(), bundle = bundleIdentity();
if (phase === "ready") {
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  assertBusinessReady(await health(), await request("/api/admin/users", { cookies: admin }));
  // Prime each independently bundled getDb consumer before introducing an unknown SQL effect.
  // The current-reader counterexample is separate from legitimate restart reconciliation.
  for (const path of ["/api/leads", "/api/leads/lead_warm", "/api/graph/drill?topic=warm&a=Atlas", "/reports", "/reports/rep_warm", "/topics/t_warm"]) {
    const response = await request(path, { cookies: admin });
    assertStatus(response.status, ["/api/leads/lead_warm", "/reports/rep_warm", "/topics/t_warm"].includes(path) ? 404 : 200);
  }
  const state = take(); assert.equal(state.ledger.length, 48); assert.equal(state.deployments.length, 1);
  const oldRun = state.runs.find(x => x.id === "run_a1b2c3d4");
  if (oldRun) { assert.equal(oldRun.status, "done"); assert.equal(state.reports.find(x => x.id === "rep_a1b2c3d4").status, "failed"); }
  db.close(); console.log(JSON.stringify({ phase, bundle, network, observations, ledger_sha256: hash(JSON.stringify(state.ledger)) }));
} else if (phase === "matrix" || phase === "restart") {
  const fixture = JSON.parse(readFileSync("/data/matrix-fixture.json"));
  assert.deepEqual(bundle, fixture.bundle);
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  if (phase === "matrix") {
    // Every unauthorized/error write also proves exact durable preservation, not just a status.
    const noMutation = async (operation, status) => {
      const before = take(); assertStatus((await operation()).status, status); assert.deepEqual(take(), before);
    };
    const topicInput = { id: "t_http_a1b2c3d4", name: "A2 HTTP new topic", keywords: ["synthetic"], language: "en", brief_schedule: "weekly", enabled: false, facets: ["domain:software-engineering"] };
    const anonymous = await request("/reports"); assertStatus(anonymous.status, 307); assert.ok(anonymous.location.includes("/login"));
    await noMutation(() => request("/api/reports"), 401);
    await noMutation(() => request("/api/reports", { cookies: new Map([["authjs.session-token", "invalid-synthetic-cookie"]]) }), 401);
    await noMutation(() => json("/api/admin/topics", undefined, topicInput), 401);
    await login(viewerEmail, "synthetic-wrong-password", false);
    await noMutation(() => json("/api/admin/users", admin, { email: "bad", password }), 422);
    await noMutation(() => json("/api/admin/users", admin, { email: viewerEmail, password: "short" }), 422);
    await noMutation(() => json("/api/admin/users", admin, { email: process.env.ADMIN_EMAIL, password }), 409);
    assertStatus((await json("/api/admin/users", admin, { email: viewerEmail, password, role: "admin" })).status, 201);
    assert.deepEqual(db.prepare("SELECT email,role FROM app_user WHERE email=?").get(viewerEmail), { email: viewerEmail, role: "viewer" });
    const viewer = await login(viewerEmail, password);
    await noMutation(() => request("/api/admin/users", { cookies: viewer }), 403);
    await noMutation(() => json("/api/admin/topics", viewer, topicInput), 403);
    await noMutation(() => json(`/api/leads/${leadId("valid_old")}`, viewer, { status: "watching" }, "POST", { "Idempotency-Key": "a2-viewer-denied" }), 403);
    const settings = await request("/settings", { cookies: viewer }); assertStatus(settings.status, 307);
    assert.ok(settings.location, "viewer settings rejection must redirect");
    const settingsTarget = new URL(settings.location, "http://127.0.0.1:3000");
    assert.equal(settingsTarget.origin, "http://127.0.0.1:3000"); assert.equal(settingsTarget.pathname, "/");
    await noMutation(() => json("/api/admin/topics", admin, {}), 422);
    for (const id of [topicInput.id, "t_http_0123456789abcdef0123456789abcdef"]) {
      const input = { ...topicInput, id };
      assertStatus((await json("/api/admin/topics", admin, input)).status, 201);
      await noMutation(() => json("/api/admin/topics", admin, input), 409);
      assertStatus((await json(`/api/admin/topics/${id}`, admin, { ...input, name: `A2 HTTP updated ${id}`, keywords: ["persisted"] }, "PUT")).status, 200);
      assert.ok((await request(`/topics/${id}`, { cookies: viewer })).text.includes(`A2 HTTP updated ${id}`));
      assert.equal(db.prepare("SELECT name FROM topic WHERE id=?").get(id).name, `A2 HTTP updated ${id}`);
    }
    await noMutation(() => json("/api/admin/topics/missing", admin, topicInput, "PUT"), 404);
    await noMutation(() => request(`/api/admin/topics/${topicId}`, { method: "DELETE", cookies: admin }), 409);

    const current = await request(`/api/leads?topic=${topicId}`, { cookies: viewer }); assertStatus(current.status, 200);
    assertVisible(current.body.items.map(x => x.id), expectedLeads);
    for (const mode of cases) {
      const response = await request(`/api/leads/${leadId(mode)}`, { cookies: viewer });
      assertStatus(response.status, mode.startsWith("valid_") ? 200 : 404);
      if (mode.startsWith("valid_")) {
        assert.equal(response.body.evidence.length, 1); assert.equal(response.body.evidence[0].insight_id, insightId(mode));
        assert.equal(response.body.evidence[0].citation_index, 1); assert.equal(response.body.evidence[0].quote, `Atlas synthetic frozen matrix ${mode}.`);
        assert.ok(!response.text.includes("fixture-not-reader-authority"));
      }
    }
    const drill = await request(`/api/graph/drill?topic=${topicId}&a=Atlas`, { cookies: viewer }); assertStatus(drill.status, 200);
    assertVisible(drill.body.items.flatMap(x => x.occurrences.map(o => o.id)), expectedInsights);
    for (const group of drill.body.items) for (const occurrence of group.occurrences) {
      assert.equal(occurrence.quotes.length, 1); assertVisible(occurrence.report_links.map(r => r.report_id), reportIds);
    }
    await noMutation(() => request("/api/graph/drill", { cookies: viewer }), 400);
    const reports = await request(`/api/reports?topic=${topicId}`, { cookies: viewer }); assertStatus(reports.status, 200);
    assertVisible(reports.body.items.map(x => x.report_id), reportIds);
    for (const [n, id] of reportIds.entries()) {
      const detail = await request(`/reports/${id}`, { cookies: viewer }); assertStatus(detail.status, 200);
      assert.ok(detail.text.includes(`A2_SNAPSHOT_BODY_${n}`)); assert.ok(detail.text.includes('id="cite-1"')); assert.ok(detail.text.includes('href="#cite-1"'));
      assert.ok(detail.text.includes(`/reports/${reportIds[1 - n]}`)); assert.ok(detail.text.includes("本地原文归档目前不可用"));
      assert.ok(!detail.text.includes("validator 屏蔽"));
    }
    for (const id of ["rep_matrix_failed", `${reportIds[0]}_wrong`, "rep_missing"]) assertStatus((await request(`/reports/${id}`, { cookies: viewer })).status, 404);
    // A new request must not use cached positive file permissions; restore only this SQL fixture archive afterwards.
    const validRaw = fixture.raw_manifest.find(x => x.mode === "valid_old").ref;
    chmodSync(`/data/${validRaw}`, 0);
    try {
      assertStatus((await request(`/api/leads/${leadId("valid_old")}`, { cookies: viewer })).status, 404);
      assertVisible((await request(`/api/leads?topic=${topicId}`, { cookies: viewer })).body.items.map(x => x.id), [leadId("valid_long")]);
      assert.ok((await request(`/reports/${reportIds[0]}`, { cookies: viewer })).text.includes("A2_SNAPSHOT_BODY_0"));
    } finally { chmodSync(`/data/${validRaw}`, 0o644); }
    assertStatus((await request(`/api/leads/${leadId("valid_old")}`, { cookies: viewer })).status, 200);

    const path = `/api/leads/${leadId("valid_old")}`;
    await noMutation(() => json(path, undefined, { status: "watching" }, "POST", { "Idempotency-Key": "a2-anon-denied" }), 401);
    await noMutation(() => json(path, admin, { status: "bad" }, "POST", { "Idempotency-Key": "a2-invalid-status" }), 400);
    await noMutation(() => json(path, admin, { status: "watching" }), 400);
    await noMutation(() => json("/api/leads/lead_missing", admin, { status: "watching" }, "POST", { "Idempotency-Key": "a2-missing-lead" }), 404);
    const beforeWriter = take();
    const changed = await json(path, admin, { status: "watching" }, "POST", { "Idempotency-Key": "a2-status-watching" }); assertStatus(changed.status, 200);
    const afterWriter = take(), traceId = changed.body.trace_id;
    const trace = db.prepare("SELECT id,scope_kind,topic_id FROM generation_trace WHERE id=?").get(traceId);
    assert.deepEqual(trace, { id: traceId, scope_kind: "manual_decision", topic_id: topicId });
    assert.equal(afterWriter.traces.length, beforeWriter.traces.length + 1);
    const entityKey = `tech_lead:v1:${Buffer.from(JSON.stringify({ id: leadId("valid_old"), kind: "id" })).toString("base64url")}`;
    assert.equal(afterWriter.refs.filter(x => x.trace_id === traceId && x.entity_key === entityKey).length, 3);
    const writer = { origin: "http", entry: path, response_status: changed.status, requested_status: "watching", trace_id: traceId,
      persisted_status: db.prepare("SELECT status FROM tech_lead WHERE id=?").get(leadId("valid_old")).status,
      persisted_trace_id: trace.id, events: afterWriter.events.filter(x => x.trace_id === traceId).length,
      released_lease: afterWriter.leases.find(x => x.trace_id === traceId).state === "released" };
    assertWriter(writer);
    const replay = await json(path, admin, { status: "watching" }, "POST", { "Idempotency-Key": "a2-status-watching" });
    assertStatus(replay.status, 200); assert.equal(replay.body.trace_id, traceId); assert.equal(replay.body.replayed, true); assert.deepEqual(take(), afterWriter);
    const newKey = await json(path, admin, { status: "watching" }, "POST", { "Idempotency-Key": "a2-status-new-request" });
    assertStatus(newKey.status, 200); assert.equal(newKey.body.replayed, false); assert.notEqual(newKey.body.trace_id, traceId);
    assert.equal(take().traces.length, afterWriter.traces.length + 1);
    assert.equal(take().events.filter(x => x.trace_id === newKey.body.trace_id).length, 2);
    // Valid credentials are revoked by the actual HTTP user writer, then deleted session is rejected too.
    assertStatus((await json("/api/admin/users", admin, { email: viewerEmail, password: `${password}-changed` })).status, 201);
    assertStatus((await request("/api/reports", { cookies: viewer })).status, 401);
    const changedViewer = await login(viewerEmail, `${password}-changed`);
    assertStatus((await request(`/api/admin/users?email=${encodeURIComponent(viewerEmail)}`, { method: "DELETE", cookies: admin })).status, 200);
    assertStatus((await request("/api/reports", { cookies: changedViewer })).status, 401);
    assertStatus((await json("/api/admin/users", admin, { email: viewerEmail, password })).status, 201);
    // Logout cookie clear through real auth route. No cookies are retained in files or logs.
    const logoutViewer = await login(viewerEmail, password);
    const csrf = await request("/api/auth/csrf", { cookies: logoutViewer, auth: true });
    const out = await request("/api/auth/signout", { cookies: logoutViewer, method: "POST", auth: true, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.body.csrfToken, callbackUrl: "http://127.0.0.1:3000/login" }) });
    assertStatus(out.status, 302); assertStatus((await request("/api/reports", { cookies: logoutViewer })).status, 401);
    assertBusinessReady(await health(), await request("/api/reports", { cookies: admin }));
    const final = take();
    assert.deepEqual(final.model_attempts, fixture.initial.model_attempts); assert.deepEqual(final.runs, fixture.initial.runs); assert.deepEqual(final.dispatch, fixture.initial.dispatch);
    assert.deepEqual(final.effects, fixture.initial.effects); assert.deepEqual(final.reports, fixture.initial.reports);
    assert.deepEqual(final.ledger, fixture.initial.ledger); assert.deepEqual(final.deployments, fixture.initial.deployments);
    assert.deepEqual(reportIds.map(id => [id, hash(readFileSync(`/data/reports/${id}.md`))]), fixture.report_hashes);
    const evidence = { phase, bundle, network, observations, writer, additional_writer_trace_id: newKey.body.trace_id, state: final, state_sha256: hash(JSON.stringify(final)),
      sql_fixture_database_sha256: fixture.database_sha256, sql_fixture_raw_manifest_sha256: fixture.raw_manifest_sha256,
      reader_visible_leads: expectedLeads, reader_visible_insights: expectedInsights, tested_cases: cases };
    writeFileSync("/data/matrix-before-restart.json", JSON.stringify(evidence));
    db.close(); console.log(JSON.stringify(evidence));
  } else {
    const before = JSON.parse(readFileSync("/data/matrix-before-restart.json")), current = take();
    // The independent unknown-effect counterexample deliberately has reader_eligible=1.
    // It is not a valid pending archive: original startup cannot finalize that inconsistent binding.
    // Retain the fixture and all business data, never make it visible to force a green restart.
    assert.deepEqual(current, before.state);
    const viewer = await login(viewerEmail, password);
    assertBusinessReady(await health(), await request("/api/reports", { cookies: viewer }));
    for (const id of ["t_http_a1b2c3d4", "t_http_0123456789abcdef0123456789abcdef"]) assert.ok((await request(`/topics/${id}`, { cookies: viewer })).text.includes(`A2 HTTP updated ${id}`));
    assertVisible((await request(`/api/leads?topic=${topicId}`, { cookies: viewer })).body.items.map(x => x.id), expectedLeads);
    assert.equal((await request(`/api/leads/${leadId("valid_old")}`, { cookies: viewer })).body.lead.status, "watching");
    assertStatus((await request(`/api/leads/${leadId("blocked")}`, { cookies: viewer })).status, 404);
    assertStatus((await request(`/api/leads/${leadId("unchecked")}`, { cookies: viewer })).status, 404);
    assert.deepEqual(reportIds.map(id => [id, hash(readFileSync(`/data/reports/${id}.md`))]), fixture.report_hashes);
    assert.deepEqual(bundle, before.bundle);
    db.close(); console.log(JSON.stringify({ phase, bundle, network, observations, persistent_state_sha256: hash(JSON.stringify(current)), writer_trace_id: before.writer.trace_id,
      writer_status: "watching", unknown_effect: { effect: "effect_unknown", status: "unknown", kind: "synthetic-inconsistent-pending-binding-retained-and-hidden" } }));
  }
} else if (phase === "failure") {
  // Failure scenarios have no fixture application state to repair. Health/business must both fail strict initialization.
  throw new Error("failure phase uses the separate fail-closed probe");
} else throw new Error("unknown matrix phase");
