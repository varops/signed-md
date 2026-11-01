import { hash, verify } from "@node-rs/argon2";
import { SignedError } from "@signed-md/core";
import { newId, now } from "@signed-md/db";
import type { Actor, Ctx } from "../context.ts";
import { hmacHex, randomToken, sha256 } from "../crypto.ts";

const SESSION_DAYS = 14;

export function hashPassword(password: string): Promise<string> {
  // argon2id with library defaults (m=19456 KiB, t=2, p=1), as recommended by OWASP.
  return hash(password);
}

export async function login(ctx: Ctx, email: string, password: string): Promise<{ token: string; userId: string } | null> {
  const user = await ctx.db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email.trim().toLowerCase())
    .where("status", "=", "active")
    .executeTakeFirst();
  // Verify against a dummy hash when the user does not exist, so timing does not reveal accounts.
  const ok = await verify(user?.password_hash ?? (await dummyHash()), password).catch(() => false);
  if (!user || !user.password_hash || !ok) return null;
  const token = randomToken(32);
  await ctx.db
    .insertInto("sessions")
    .values({
      id: sha256(token),
      user_id: user.id,
      created_at: now(),
      expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
    })
    .execute();
  return { token, userId: user.id };
}

let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummy ??= hash("not-a-real-password");
  return dummy;
}

export async function sessionActor(ctx: Ctx, token: string | undefined): Promise<(Actor & { kind: "user" }) | null> {
  if (!token) return null;
  const row = await ctx.db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select(["users.id as user_id", "users.account_id", "users.email", "users.status", "sessions.expires_at"])
    .where("sessions.id", "=", sha256(token))
    .executeTakeFirst();
  if (!row || row.status !== "active" || row.expires_at < now()) return null;
  return { kind: "user", id: row.user_id, accountId: row.account_id, label: row.email };
}

export async function logout(ctx: Ctx, token: string | undefined): Promise<void> {
  if (!token) return;
  // Expire rather than delete: nothing is ever deleted.
  await ctx.db.updateTable("sessions").set({ expires_at: now() }).where("id", "=", sha256(token)).execute();
}

/** CSRF token bound to the session. */
export function csrfToken(ctx: Ctx, sessionToken: string): string {
  return hmacHex(ctx.keys.serverSecret, `csrf:${sha256(sessionToken)}`).slice(0, 32);
}

export async function changePassword(ctx: Ctx, userId: string, password: string): Promise<void> {
  if (password.length < 10) throw new SignedError("INVALID_REQUEST", "Password must be at least 10 characters");
  await ctx.db.updateTable("users").set({ password_hash: await hashPassword(password) }).where("id", "=", userId).execute();
}

// ---- API keys ----

export interface ApiKeyView {
  id: string;
  label: string;
  prefix: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function createApiKey(ctx: Ctx, actor: Actor & { kind: "user" }, label: string): Promise<{ key: string; view: ApiKeyView }> {
  const key = `smd_${randomToken(30)}`;
  const id = newId("key");
  const row = {
    id,
    account_id: actor.accountId,
    // v1.0 keys belong to the installation; v1.1 assigns each key to its user.
    user_id: null,
    key_hash: sha256(key),
    prefix: key.slice(0, 10),
    label: label.trim() || "API key",
    scope: "all",
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  await ctx.db.insertInto("api_keys").values(row).execute();
  return { key, view: viewKey(row) };
}

function viewKey(r: ApiKeyView & Record<string, unknown>): ApiKeyView {
  return { id: r.id, label: r.label, prefix: r.prefix, scope: r.scope, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at };
}

export async function listApiKeys(ctx: Ctx): Promise<ApiKeyView[]> {
  const rows = await ctx.db.selectFrom("api_keys").selectAll().orderBy("created_at", "desc").execute();
  return rows.map(viewKey);
}

export async function revokeApiKey(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.updateTable("api_keys").set({ revoked_at: now() }).where("id", "=", id).where("revoked_at", "is", null).execute();
}

export async function apiKeyActor(ctx: Ctx, key: string | undefined, via: "api" | "mcp"): Promise<Actor | null> {
  if (!key || !key.startsWith("smd_")) return null;
  const row = await ctx.db.selectFrom("api_keys").selectAll().where("key_hash", "=", sha256(key)).executeTakeFirst();
  if (!row || row.revoked_at) return null;
  // Touch last_used_at at most once a minute.
  const t = now();
  if (!row.last_used_at || Date.parse(t) - Date.parse(row.last_used_at) > 60_000) {
    await ctx.db.updateTable("api_keys").set({ last_used_at: t }).where("id", "=", row.id).execute();
  }
  return { kind: "apikey", id: row.id, accountId: row.account_id, label: row.label, via };
}
