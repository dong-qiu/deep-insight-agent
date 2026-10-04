import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "@auth/core";
import NextAuth, { type NextAuthRequest } from "next-auth";
import { encode } from "next-auth/jwt";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";

const fixture = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("./lib/db/auth-reader.js", () => ({ readCurrentSessionUser: fixture.lookup }));
import { authNodeConfig } from "./auth.node-config.js";

const secret = "synthetic-logout-regression-secret";
const current = { id: "synthetic-viewer", email: "viewer@example.test", name: "viewer", role: "viewer", sessionVersion: "a".repeat(64) };
const event = { waitUntil: vi.fn() } as unknown as NextFetchEvent;
let middleware: typeof import("./middleware.js").default;
type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
const sessionCookies = (jar: Jar) => [...jar.keys()].filter(name => /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name));
function applyCookies(jar: Jar, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const match = /^([^=;]+)=([^;]*)/.exec(header);
    if (!match) continue;
    if (/;\s*max-age=0(?:;|$)/i.test(header)) jar.delete(match[1]);
    else jar.set(match[1], match[2]);
  }
}
async function loggedIn(secure: boolean, chunked: boolean): Promise<Jar> {
  const name = `${secure ? "__Secure-" : ""}authjs.session-token`;
  const token = await encode({ secret, salt: name, token: { ...current, sub: current.id, name: chunked ? "x".repeat(12_000) : current.name } });
  return chunked ? new Map((token.match(/.{1,3800}/g) ?? []).map((chunk, i) => [`${name}.${i}`, chunk])) : new Map([[name, token]]);
}
const origin = (secure: boolean) => `${secure ? "https" : "http"}://synthetic.example.test`;
function request(base: string, jar: Jar, method: string, rsc = false): NextRequest {
  return new NextRequest(`${base}/reports`, { method, headers: { cookie: cookieHeader(jar),
    "x-forwarded-proto": new URL(base).protocol.slice(0, -1), ...(rsc ? { RSC: "1", "next-router-prefetch": "1" } : {}) } });
}
async function logout(base: string, jar: Jar): Promise<void> {
  const config = { ...authNodeConfig, secret, basePath: "/api/auth" };
  const csrf = await Auth(new Request(`${base}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } }), config);
  applyCookies(jar, csrf);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const response = await Auth(new Request(`${base}/api/auth/signout`, { method: "POST",
    headers: { cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${base}/login` }) }), config);
  expect(response.status).toBe(302);
  applyCookies(jar, response);
  expect(sessionCookies(jar)).toHaveLength(0);
}
beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", undefined);
  vi.stubEnv("NEXTAUTH_URL", undefined);
  middleware = (await import("./middleware.js")).default;
});
beforeEach(() => { fixture.lookup.mockReset().mockReturnValue(current); });
afterAll(() => vi.unstubAllEnvs());

describe("middleware authentication remains read-only across logout", () => {
  it.each([
    { secure: false, chunked: false, method: "GET", rsc: false },
    { secure: false, chunked: false, method: "GET", rsc: true },
    { secure: false, chunked: false, method: "POST", rsc: false },
    { secure: true, chunked: true, method: "GET", rsc: true },
  ])("late $method response (secure=$secure, chunked=$chunked, rsc=$rsc) cannot restore logout", async ({ secure, chunked, method, rsc }) => {
    const base = origin(secure), jar = await loggedIn(secure, chunked);
    // Positive control: the real unmodified Auth.js wrapper produces refreshed cookies.
    const raw = NextAuth({ ...authNodeConfig, secret }).auth((_req: NextAuthRequest, _event: NextFetchEvent) => NextResponse.next());
    const rawResponse = await raw(request(base, jar, method, rsc), event);
    expect(rawResponse!.headers.getSetCookie().some(h => /authjs\.session-token/.test(h))).toBe(true);
    const held = await middleware(request(base, jar, method, rsc), event);
    expect(held?.status).toBe(200);
    expect(held!.headers.get("x-middleware-next")).toBe("1");
    const otherCookieNames = (response: Response) => response.headers.getSetCookie()
      .filter(h => !/authjs\.session-token/.test(h)).map(h => h.split("=")[0]).sort();
    expect(otherCookieNames(rawResponse as Response).length).toBeGreaterThan(0);
    expect(otherCookieNames(held as Response)).toEqual(otherCookieNames(rawResponse as Response));
    await logout(base, jar);
    // Apply the already-authorized response AFTER the actual Auth.js logout.
    applyCookies(jar, held as Response);
    expect(sessionCookies(jar)).toHaveLength(0);
    const denied = await middleware(request(base, jar, "GET"), event);
    expect(denied?.status).toBe(307);
    expect(new URL(denied!.headers.get("location")!).pathname).toBe("/login");
  });

  it("keeps existing authorization and credential-revocation boundaries", async () => {
    const base = origin(false), jar = await loggedIn(false, false);
    const get = (path: string, cookies = jar) => middleware(new NextRequest(`${base}${path}`, { headers: { cookie: cookieHeader(cookies), "x-forwarded-proto": "http" } }), event);
    expect((await get("/reports"))?.status).toBe(200);
    expect((await get("/admin"))?.headers.get("location")).toBe(`${base}/`);
    expect((await get("/api/admin/users"))?.status).toBe(403);
    expect((await get("/api/reports", new Map()))?.status).toBe(401);
    expect((await get("/api/admin/metrics", new Map()))?.status).toBe(404);
    fixture.lookup.mockReturnValue({ ...current, sessionVersion: "b".repeat(64) });
    expect((await get("/api/reports"))?.status).toBe(401);
    fixture.lookup.mockImplementation(() => { throw new Error("synthetic database unavailable"); });
    expect((await get("/reports"))?.status).toBe(307);
  });
});
