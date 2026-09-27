/** Node-only session verification without Credentials/getDb's writer initialization. ADR-0037. */
import type { NextAuthConfig } from "next-auth";
import { authConfig } from "./auth.config.js";
import { createSessionJwt } from "./lib/runtime/session-jwt.js";

export const authNodeConfig = {
  ...authConfig,
  callbacks: { ...authConfig.callbacks, jwt: createSessionJwt() },
} satisfies NextAuthConfig;
