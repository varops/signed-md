import { SignedError } from "@signed-md/core";
import { type Database, enqueueJob, newId, now } from "@signed-md/db";
import type { Kysely } from "kysely";
import type { Ctx } from "../context.ts";
import { randomToken, seal, sha256 } from "../crypto.ts";
import { recordAudit } from "./audit.ts";
import { createSession, hashPassword } from "./auth.ts";

/**
 * "Forgot password" for email login. Someone asks for a link; if the email belongs to an active
 * person, they get a link that works once and expires after an hour. The answer is the same
 * whether or not the email exists, so the form doesn't reveal who has an account.
 *
 * Without email login (ALLOW_EMAIL_LOGIN=false) there are no passwords, so nothing happens.
 * Without SMTP, links aren't emailed (see canEmailResets).
 */
export const RESET_MINUTES = 60;
/** At most one email per person in this window, so the form can't be used to flood an inbox. */
const RESEND_SECONDS = 60;

/**
 * Reset links go by email only over real SMTP. Without it, emails land in the in-app Outbox, where
 * any administrator could read an owner's link. Operators use `cli.ts reset-password` instead.
 */
export function canEmailResets(ctx: Ctx): boolean {
  return ctx.config.allowEmailLogin && ctx.mailer.smtp !== null;
}

/** A new link for this person. It cancels any older one. */
async function newLink(ctx: Ctx, db: Kysely<Database>, userId: string): Promise<{ id: string; url: string }> {
  const token = randomToken(32);
  const id = newId("pwr");
  await db.updateTable("password_resets").set({ used_at: now() }).where("user_id", "=", userId).where("used_at", "is", null).execute();
  await db
    .insertInto("password_resets")
    .values({ id, user_id: userId, token_hash: sha256(token), created_at: now(), expires_at: new Date(Date.now() + RESET_MINUTES * 60_000).toISOString(), used_at: null })
    .execute();
  return { id, url: `${ctx.config.publicUrl}/reset/${token}` };
}

async function activeUser(ctx: Ctx, email: string) {
  const user = await ctx.db.selectFrom("users").select(["id", "status"]).where("email", "=", email.trim().toLowerCase()).executeTakeFirst();
  return user?.status === "active" ? user : null;
}

/** "Forgot password": email a link if the address belongs to an active person. Says nothing either way. */
export async function requestPasswordReset(ctx: Ctx, email: string): Promise<void> {
  if (!canEmailResets(ctx)) return;
  const user = await activeUser(ctx, email);
  if (!user) return;
  const recent = await ctx.db
    .selectFrom("password_resets")
    .select("id")
    .where("user_id", "=", user.id)
    .where("created_at", ">", new Date(Date.now() - RESEND_SECONDS * 1000).toISOString())
    .executeTakeFirst();
  if (recent) return;
  await ctx.db.transaction().execute(async (trx) => {
    const link = await newLink(ctx, trx, user.id);
    await enqueueJob(trx, "email", { kind: "password_reset", reset_id: link.id, link: seal(ctx.keys.serverSecret, link.url) });
  });
}

/** For operators (CLI): a reset link to hand over directly, with no email. */
export async function passwordResetLink(ctx: Ctx, email: string): Promise<string> {
  if (!ctx.config.allowEmailLogin) throw new SignedError("PERMISSION_DENIED", "Email login is turned off, so there are no passwords to reset.");
  const user = await activeUser(ctx, email);
  if (!user) throw new SignedError("NOT_FOUND", `No active user ${email}`);
  return (await newLink(ctx, ctx.db, user.id)).url;
}

/** The person a reset link is for, while it is still usable. */
export async function findPasswordReset(ctx: Ctx, token: string): Promise<{ id: string; user_id: string; email: string } | null> {
  if (!ctx.config.allowEmailLogin || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await ctx.db
    .selectFrom("password_resets")
    .innerJoin("users", "users.id", "password_resets.user_id")
    .select(["password_resets.id", "password_resets.user_id", "password_resets.expires_at", "password_resets.used_at", "users.email", "users.status"])
    .where("password_resets.token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!row || row.used_at || row.expires_at < now() || row.status !== "active") return null;
  return { id: row.id, user_id: row.user_id, email: row.email };
}

/** Set a new password with a reset link, use up the link, and return a login cookie. */
export async function resetPassword(ctx: Ctx, token: string, password: string): Promise<string> {
  const reset = await findPasswordReset(ctx, token);
  if (!reset) throw new SignedError("INVALID_REQUEST", "This link has expired or was already used. Ask for a new one.");
  if (password.length < 10) throw new SignedError("INVALID_REQUEST", "Password must be at least 10 characters");
  const passwordHash = await hashPassword(password);
  const used = await ctx.db.transaction().execute(async (trx) => {
    // Claim the link first, so two requests with the same link can't both succeed.
    const res = await trx.updateTable("password_resets").set({ used_at: now() }).where("id", "=", reset.id).where("used_at", "is", null).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) return false;
    await trx.updateTable("users").set({ password_hash: passwordHash }).where("id", "=", reset.user_id).execute();
    return true;
  });
  if (!used) throw new SignedError("INVALID_REQUEST", "This link has expired or was already used. Ask for a new one.");
  const user = await ctx.db.selectFrom("users").select(["id", "account_id", "email", "name", "role"]).where("id", "=", reset.user_id).executeTakeFirstOrThrow();
  await recordAudit(ctx.db, { kind: "user", id: user.id, accountId: user.account_id, label: user.email, name: user.name || user.email, role: user.role }, "password.reset", {});
  return createSession(ctx, user.id);
}
