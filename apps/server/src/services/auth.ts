import { hash, verify } from "@node-rs/argon2";
import { SignedError } from "@signed-md/core";
import { newId, now } from "@signed-md/db";
import type { Actor, Ctx } from "../context.ts";
import { recordAudit } from "./audit.ts";
import { can, isAccountActive, userIdOf } from "./permissions.ts";

const DISABLED = "This account is disabled.";
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
  // A disabled (read-only) account: only owners can still log in.
  if (!isAccountActive() && user.role !== "owner") throw new SignedError("PERMISSION_DENIED", DISABLED);
  await ctx.db.updateTable("users").set({ last_login_at: now() }).where("id", "=", user.id).execute();
  return { token: await createSession(ctx, user.id), userId: user.id };
}

export async function createSession(ctx: Ctx, userId: string): Promise<string> {
  const token = randomToken(32);
  await ctx.db
    .insertInto("sessions")
    .values({
      id: sha256(token),
      user_id: userId,
      created_at: now(),
      expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
    })
    .execute();
  return token;
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
    .select(["users.id as user_id", "users.account_id", "users.email", "users.name", "users.role", "users.theme", "users.status", "sessions.expires_at"])
    .where("sessions.id", "=", sha256(token))
    .executeTakeFirst();
  if (!row || row.status !== "active" || row.expires_at < now()) return null;
  if (!isAccountActive() && row.role !== "owner") return null;
  return { kind: "user", id: row.user_id, accountId: row.account_id, label: row.email, name: row.name || row.email.split("@")[0]!, role: row.role, theme: (["light", "dark"].includes(row.theme) ? row.theme : "system") as "system" | "light" | "dark" };
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
  owner: { id: string | null; name: string; email: string } | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Every key belongs to a person and acts with that person's role. */
export async function createApiKey(ctx: Ctx, actor: Actor & { kind: "user" }, label: string): Promise<{ key: string; view: ApiKeyView }> {
  const key = `smd_${randomToken(30)}`;
  const id = newId("key");
  const row = {
    id,
    account_id: actor.accountId,
    user_id: actor.id,
    key_hash: sha256(key),
    prefix: key.slice(0, 10),
    label: label.trim().slice(0, 100) || "API key",
    scope: "role",
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  await ctx.db.insertInto("api_keys").values(row).execute();
  await recordAudit(ctx.db, actor, "apikey.created", { label: row.label });
  return { key, view: { ...viewKey(row), owner: { id: actor.id, name: actor.name, email: actor.label } } };
}

function viewKey(r: { id: string; label: string; prefix: string; scope: string; created_at: string; last_used_at: string | null; revoked_at: string | null }): Omit<ApiKeyView, "owner"> {
  return { id: r.id, label: r.label, prefix: r.prefix, scope: r.scope, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at };
}

/** Your own keys, or everyone's for owners and administrators. */
export async function listApiKeys(ctx: Ctx, actor: Actor): Promise<ApiKeyView[]> {
  let q = ctx.db
    .selectFrom("api_keys")
    .leftJoin("users", "users.id", "api_keys.user_id")
    .select(["api_keys.id", "api_keys.label", "api_keys.prefix", "api_keys.scope", "api_keys.created_at", "api_keys.last_used_at", "api_keys.revoked_at", "api_keys.user_id", "users.name", "users.email"])
    .orderBy("api_keys.created_at", "desc");
  if (!can(actor, "keys.manage_all")) q = q.where("api_keys.user_id", "=", userIdOf(actor) ?? "");
  const rows = await q.execute();
  return rows.map((r) => ({ ...viewKey(r), owner: r.user_id ? { id: r.user_id, name: r.name || (r.email ?? "").split("@")[0]!, email: r.email ?? "" } : null }));
}

export async function revokeApiKey(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  const key = await ctx.db.selectFrom("api_keys").selectAll().where("id", "=", id).executeTakeFirst();
  if (!key || (key.user_id !== userIdOf(actor) && !can(actor, "keys.manage_all"))) throw new SignedError("NOT_FOUND", "API key not found");
  if (key.revoked_at) return;
  await ctx.db.updateTable("api_keys").set({ revoked_at: now() }).where("id", "=", id).execute();
  await recordAudit(ctx.db, actor, "apikey.revoked", { label: key.label });
}

/** A key works only while it is not revoked and its owner is active. It carries the owner's current role. */
export async function apiKeyActor(ctx: Ctx, key: string | undefined, via: "api" | "mcp"): Promise<Actor | null> {
  if (!key || !key.startsWith("smd_")) return null;
  const row = await ctx.db
    .selectFrom("api_keys")
    .innerJoin("users", "users.id", "api_keys.user_id")
    .select(["api_keys.id", "api_keys.account_id", "api_keys.label", "api_keys.revoked_at", "api_keys.last_used_at", "users.id as user_id", "users.name", "users.email", "users.role", "users.status"])
    .where("api_keys.key_hash", "=", sha256(key))
    .executeTakeFirst();
  if (!row || row.revoked_at || row.status !== "active") return null;
  if (!isAccountActive() && row.role !== "owner") throw new SignedError("PERMISSION_DENIED", DISABLED);
  // Touch last_used_at at most once a minute.
  const t = now();
  if (!row.last_used_at || Date.parse(t) - Date.parse(row.last_used_at) > 60_000) {
    await ctx.db.updateTable("api_keys").set({ last_used_at: t }).where("id", "=", row.id).execute();
  }
  return { kind: "apikey", id: row.id, accountId: row.account_id, label: row.label, via, userId: row.user_id, userName: row.name || row.email.split("@")[0]!, role: row.role };
}
