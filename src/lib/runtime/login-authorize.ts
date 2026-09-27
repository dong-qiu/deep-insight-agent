import { createHash } from "node:crypto";
import type { AppUser } from "../../auth.config.js";
import { normEmail } from "../db/users.js";
import { LoginThrottle } from "./login-throttle.js";

export class LoginRateLimited extends Error {
  readonly code = "rate_limited";
  constructor() { super("login rate limited"); }
}

/** Keep the guard inside authorize so both the HTTP callback and server signIn use it.
 * authenticate is synchronous (SQLite + scrypt); admission is consumed before any DB/hash work. */
export function createLoginAuthorizer(
  authenticate: (email: string, password: string) => AppUser | null,
  throttle = new LoginThrottle(),
) {
  return (credentials: Partial<Record<"email" | "password", unknown>> | undefined): AppUser | null => {
    const email = credentials?.email, password = credentials?.password;
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) return null;
    const normalized = normEmail(email);
    const key = createHash("sha256").update(normalized).digest("hex");
    if (!throttle.take(key)) throw new LoginRateLimited();
    const user = authenticate(normalized, password);
    if (user) throttle.succeeded(key);
    return user;
  };
}
