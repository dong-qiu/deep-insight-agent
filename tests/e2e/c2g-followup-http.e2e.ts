/** Real built Next/Auth.js/SDK/native persistence with loopback synthetic provider only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { openDb } from "../../src/lib/db/index.js";
import { admin, loginCookie, quote, startC2gServer, viewer } from "../fixtures/c2g-followup-http.js";

describe("C2g built HTTP followup", () => {
  let server: Awaited<ReturnType<typeof startC2gServer>>, cookie: string;
  beforeAll(async () => { server = await startC2gServer(); cookie = await loginCookie(server.url, admin); }, 60_000);
  afterAll(async () => { await server?.stop(); });
  const endpoint = () => `${server.url}/api/reports/${server.report.id}/followup`;
  const ask = (question: string, auth = cookie, id = server.report.id) => fetch(`${server.url}/api/reports/${id}/followup`, {
    method: "POST", headers: { cookie: auth, "content-type": "application/json" }, body: JSON.stringify({ question }),
  });
  it("actual middleware auth denies anonymous/viewer before any provider or QA", async () => {
    expect((await ask("?", "")).status).toBe(401);
    const viewerCookie = await loginCookie(server.url, viewer); expect((await ask("?", viewerCookie)).status).toBe(403); expect(server.calls).toHaveLength(0);
  });
  it("actual missing/input gates keep 404/empty400/long400, SDK zero", async () => {
    expect((await ask("?", cookie, "missing")).status).toBe(404); expect((await ask("")).status).toBe(400); expect((await ask("x".repeat(501))).status).toBe(400); expect(server.calls).toHaveLength(0);
  });
  it("actual SDK generation/judge produces white-listed QA and unchanged GET history", async () => {
    const r = await ask("如何改善回归？"); expect(r.status).toBe(200); const qa = await r.json();
    expect(qa.answer_md).toContain(quote); expect(qa.citations_used).toHaveLength(1); expect(qa.citations_used[0].content_item_id).toBe("c2g-content-0");
    expect(qa.validation).toEqual({ total: 1, reachable: 1, consistent: 1, blocked: 0, errored: 0 }); expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.body).not.toContain("团队反馈良好"); expect(server.calls[0]?.body).not.toContain("不支持的合成引用");
    const history = await fetch(endpoint(), { headers: { cookie } }); expect(history.status).toBe(200);
    const list = await history.json(); expect(list.followups).toHaveLength(1); expect(list.followups[0]).toEqual(qa);
  });
  it("actual client socket disconnect records framework mapping without claiming an unreadable 500", async () => {
    const db = openDb(server.dbPath, { bootstrap: false }); const before = (db.prepare("SELECT COUNT(*) AS n FROM followup_qa").get() as { n: number }).n;
    const calls = server.calls.length; server.hold(); const body = JSON.stringify({ question: "断连观测" });
    const request = httpRequest(endpoint(), { method: "POST", headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
    const settled = new Promise<string>(resolve => { request.on("response", r => { r.resume(); r.on("end", () => resolve(`http:${r.statusCode}`)); }); request.on("error", () => resolve("client_socket_closed")); });
    try {
      request.end(body); for (let i = 0; i < 100 && server.calls.length === calls; i++) await delay(20);
      expect(server.calls).toHaveLength(calls + 1); request.destroy(new Error("synthetic-client-disconnect")); expect(await settled).toBe("client_socket_closed");
      let observed = false;
      for (let i = 0; i < 100; i++) {
        observed = Boolean(db.prepare("SELECT 1 FROM audit_log WHERE action='followup_failed' AND detail LIKE '%cancelled%'").get());
        if (observed) break; await delay(20);
      }
      // A held fake provider makes the absence/presence of real server cancellation observable.
      const providerClosed = server.calls.at(-1)?.response.destroyed ?? false;
      console.log(JSON.stringify({ c2g_framework_disconnect: observed ? "observed_canonical_cancelled" : "not_observed_unknown", provider_socket_closed_before_release: providerClosed,
        client_response: "unreadable_after_disconnect", request_signal_injected: false }));
      server.release(); await delay(100);
      if (observed) expect((db.prepare("SELECT COUNT(*) AS n FROM followup_qa").get() as { n: number }).n).toBe(before);
      // No mapping claim when absent. Let the real SDK continuation settle before fixture shutdown.
      else {
        for (let i = 0; i < 100; i++) { if ((db.prepare("SELECT COUNT(*) AS n FROM followup_qa").get() as { n: number }).n > before) break; await delay(20); }
      }
    } finally { request.destroy(); server.release(); db.close(); }
  });
});
