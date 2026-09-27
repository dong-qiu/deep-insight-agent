import { timingSafeEqual } from "node:crypto";
import type { NextAuthConfig } from "next-auth";
import { readCurrentSessionUser } from "../db/auth-reader.js";
import { normEmail, type SessionUser } from "../db/users.js";

type JwtCallback = NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>;
const isVersion = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Shared by API/server auth and Node middleware. Client session-update payload is deliberately ignored. */
export function createSessionJwt(lookup: (email: string) => SessionUser | null = readCurrentSessionUser): JwtCallback {
  return ({ token, user }) => {
    if (user) {
      const authenticated = user as Partial<SessionUser>;
      if (!isVersion(authenticated.sessionVersion)) return null;
      token.sessionVersion = authenticated.sessionVersion;
      token.role = authenticated.role;
      token.sub = authenticated.id;
      token.email = authenticated.email;
    }
    if (!isVersion(token.sessionVersion) || typeof token.email !== "string" || !token.email
      || typeof token.sub !== "string" || (token.role !== "admin" && token.role !== "viewer")) return null;
    try {
      const current = lookup(token.email);
      if (!current || current.id !== token.sub || normEmail(current.email) !== normEmail(token.email)
        || current.role !== token.role || !isVersion(current.sessionVersion)
        || !timingSafeEqual(Buffer.from(current.sessionVersion, "hex"), Buffer.from(token.sessionVersion, "hex"))) return null;
      return token;
    } catch {
      // Unavailable/corrupt DB or secret means no authenticated user, never stale-cookie fallback.
      return null;
    }
  };
}
