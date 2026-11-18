// Signed.md login cookie, for your own sign-in service. Server-side only: it needs COOKIE_HASH_KEY.
// Node 22+ (runs as TypeScript directly). See README.md.
import { createHmac } from "node:crypto";

export const COOKIE_NAME = "smd_session";
export const MAX_AGE = 3600;

/** The cookie value for a person you have signed in. `now` is a Unix time in seconds, for tests. */
export function cookieValue(email: string, key: string, now: number = Math.floor(Date.now() / 1000)): string {
  const body = `v1.${Buffer.from(email.trim().toLowerCase()).toString("base64url")}.${now + MAX_AGE}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** A complete Set-Cookie header. `domain` is your COOKIE_DOMAIN, such as ".example.com". */
export function setCookieHeader(email: string, key: string, domain?: string, now?: number): string {
  return `${COOKIE_NAME}=${cookieValue(email, key, now)}; Max-Age=${MAX_AGE}; Path=/;${domain ? ` Domain=${domain};` : ""} HttpOnly; Secure; SameSite=Lax`;
}
