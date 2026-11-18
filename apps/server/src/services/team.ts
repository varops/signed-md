import { SignedError } from "@signed-md/core";
import { enqueueJob, newId, now } from "@signed-md/db";
import type { Actor, Ctx, Role } from "../context.ts";
import { randomToken, seal, sha256 } from "../crypto.ts";
import { recordAudit } from "./audit.ts";
import { createSession, hashPassword } from "./auth.ts";
import { ROLES, requirePermission, roleOf, userIdOf } from "./permissions.ts";

const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  invited_by: string;
  created_at: string;
  expires_at: string;
}

function checkRole(role: string): Role {
  if (!(ROLES as string[]).includes(role)) throw new SignedError("INVALID_REQUEST", `Unknown role '${role}'`);
  return role as Role;
}

/** Only owners can grant or take away the owner role, or act on another owner. */
function requireCanAssign(actor: Actor, role: Role): void {
  if (role === "owner" && roleOf(actor) !== "owner" && actor.kind !== "system") {
    throw new SignedError("PERMISSION_DENIED", "Only an owner can make someone an owner.");
  }
}

export async function listMembers(ctx: Ctx): Promise<TeamMember[]> {
  const rows = await ctx.db.selectFrom("users").select(["id", "email", "name", "role", "status", "last_login_at", "created_at"]).orderBy("created_at").execute();
  return rows.map((r) => ({ ...r, name: r.name || r.email.split("@")[0]! }));
}

export async function listInvitations(ctx: Ctx): Promise<PendingInvitation[]> {
  return ctx.db
    .selectFrom("invitations")
    .leftJoin("users", "users.id", "invitations.invited_by")
    .select(["invitations.id", "invitations.email", "invitations.role", "invitations.created_at", "invitations.expires_at", "users.name as inviter_name", "users.email as inviter_email"])
    .where("invitations.accepted_at", "is", null)
    .where("invitations.revoked_at", "is", null)
    .where("invitations.expires_at", ">", now())
    .orderBy("invitations.created_at", "desc")
    .execute()
    .then((rows) => rows.map((r) => ({ id: r.id, email: r.email, role: r.role, created_at: r.created_at, expires_at: r.expires_at, invited_by: r.inviter_name || r.inviter_email || "" })));
}

/** Invite someone by email. A newer invitation for the same email replaces an older one. */
export async function inviteMember(ctx: Ctx, actor: Actor, input: { email: string; role: string }): Promise<void> {
  requirePermission(actor, "team.manage");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new SignedError("INVALID_REQUEST", "Enter a valid email address");
  const role = checkRole(input.role);
  requireCanAssign(actor, role);
  const existing = await ctx.db.selectFrom("users").select(["id", "status"]).where("email", "=", email).executeTakeFirst();
  if (existing) {
    throw new SignedError("INVALID_REQUEST", existing.status === "active" ? `${email} is already on the team` : `${email} was deactivated. Reactivate them instead.`);
  }
  const account = await ctx.db.selectFrom("accounts").select("id").limit(1).executeTakeFirstOrThrow();
  const token = randomToken(32);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable("invitations").set({ revoked_at: now() }).where("email", "=", email).where("accepted_at", "is", null).where("revoked_at", "is", null).execute();
    const id = newId("inv");
    await trx
      .insertInto("invitations")
      .values({
        id,
        account_id: account.id,
        email,
        role,
        token_hash: sha256(token),
        invited_by: userIdOf(actor) ?? "system",
        created_at: now(),
        expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString(),
        accepted_at: null,
        revoked_at: null,
      })
      .execute();
    await enqueueJob(trx, "email", { kind: "invitation", invitation_id: id, link: seal(ctx.keys.serverSecret, `${ctx.config.publicUrl}/invite/${token}`) });
  });
  await recordAudit(ctx.db, actor, "team.invited", { email, role });
}

export async function revokeInvitation(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  requirePermission(actor, "team.manage");
  const inv = await ctx.db.selectFrom("invitations").selectAll().where("id", "=", id).executeTakeFirst();
  if (!inv || inv.accepted_at || inv.revoked_at) return;
  requireCanAssign(actor, inv.role);
  await ctx.db.updateTable("invitations").set({ revoked_at: now() }).where("id", "=", id).execute();
  await recordAudit(ctx.db, actor, "team.invite_revoked", { email: inv.email });
}

/** Send a fresh invitation link to the same email and role. */
export async function resendInvitation(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  const inv = await ctx.db.selectFrom("invitations").selectAll().where("id", "=", id).executeTakeFirst();
  if (!inv || inv.accepted_at || inv.revoked_at) throw new SignedError("NOT_FOUND", "Invitation not found");
  await inviteMember(ctx, actor, { email: inv.email, role: inv.role });
}

export async function findInvitation(ctx: Ctx, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const inv = await ctx.db.selectFrom("invitations").selectAll().where("token_hash", "=", sha256(token)).executeTakeFirst();
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < now()) return null;
  const account = await ctx.db.selectFrom("accounts").select("name").limit(1).executeTakeFirstOrThrow();
  const inviter = await ctx.db.selectFrom("users").select(["name", "email"]).where("id", "=", inv.invited_by).executeTakeFirst();
  return { ...inv, account_name: account.name, inviter: inviter ? inviter.name || inviter.email : null };
}

/** Accept an invitation: create the user and log them in. Returns a session token. */
export async function acceptInvitation(ctx: Ctx, token: string, input: { name: string; password: string }): Promise<string> {
  const inv = await findInvitation(ctx, token);
  if (!inv) throw new SignedError("INVALID_REQUEST", "This invitation is not valid or has expired. Ask for a new one.");
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new SignedError("INVALID_REQUEST", "Enter your name");
  if (input.password.length < 10) throw new SignedError("INVALID_REQUEST", "Password must be at least 10 characters");
  const passwordHash = await hashPassword(input.password);
  const userId = newId("usr");
  await ctx.db.transaction().execute(async (trx) => {
    const taken = await trx.selectFrom("users").select("id").where("email", "=", inv.email).executeTakeFirst();
    if (taken) throw new SignedError("INVALID_REQUEST", "This email already has an account. Log in instead.");
    await trx
      .insertInto("users")
      .values({ id: userId, account_id: inv.account_id, email: inv.email, name, role: inv.role, password_hash: passwordHash, status: "active", invited_by: inv.invited_by, last_login_at: now(), deactivated_at: null, theme: "system", created_at: now() })
      .execute();
    await trx.updateTable("invitations").set({ accepted_at: now() }).where("id", "=", inv.id).execute();
  });
  await recordAudit(ctx.db, { kind: "user", id: userId, accountId: inv.account_id, label: inv.email, name, role: inv.role }, "team.joined", { role: inv.role });
  return createSession(ctx, userId);
}

async function activeOwners(ctx: Ctx): Promise<number> {
  const r = await ctx.db.selectFrom("users").select((eb) => eb.fn.countAll<number>().as("n")).where("role", "=", "owner").where("status", "=", "active").executeTakeFirstOrThrow();
  return Number(r.n);
}

async function targetUser(ctx: Ctx, actor: Actor, userId: string) {
  requirePermission(actor, "team.manage");
  const user = await ctx.db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
  if (!user) throw new SignedError("NOT_FOUND", "User not found");
  if (user.role === "owner") requireCanAssign(actor, "owner");
  return user;
}

export async function changeRole(ctx: Ctx, actor: Actor, userId: string, newRole: string): Promise<void> {
  const role = checkRole(newRole);
  const user = await targetUser(ctx, actor, userId);
  requireCanAssign(actor, role);
  if (user.role === role) return;
  if (user.role === "owner" && user.status === "active" && (await activeOwners(ctx)) <= 1) {
    throw new SignedError("INVALID_REQUEST", "There must be at least one owner. Make someone else an owner first.");
  }
  await ctx.db.updateTable("users").set({ role }).where("id", "=", userId).execute();
  await recordAudit(ctx.db, actor, "team.role_changed", { email: user.email, from: user.role, to: role });
}

/** Deactivate (never delete). Their sessions and API keys stop working at once. Their documents stay. */
export async function deactivateMember(ctx: Ctx, actor: Actor, userId: string): Promise<void> {
  const user = await targetUser(ctx, actor, userId);
  if (userId === userIdOf(actor)) throw new SignedError("INVALID_REQUEST", "You can't deactivate yourself.");
  if (user.status === "disabled") return;
  if (user.role === "owner" && (await activeOwners(ctx)) <= 1) throw new SignedError("INVALID_REQUEST", "There must be at least one active owner.");
  await ctx.db.updateTable("users").set({ status: "disabled", deactivated_at: now() }).where("id", "=", userId).execute();
  await ctx.db.updateTable("sessions").set({ expires_at: now() }).where("user_id", "=", userId).where("expires_at", ">", now()).execute();
  await recordAudit(ctx.db, actor, "team.deactivated", { email: user.email });
}

export async function reactivateMember(ctx: Ctx, actor: Actor, userId: string): Promise<void> {
  const user = await targetUser(ctx, actor, userId);
  if (user.status === "active") return;
  await ctx.db.updateTable("users").set({ status: "active", deactivated_at: null }).where("id", "=", userId).execute();
  await recordAudit(ctx.db, actor, "team.reactivated", { email: user.email });
}

export async function updateProfile(ctx: Ctx, actor: Actor & { kind: "user" }, input: { name: string; theme?: string }): Promise<void> {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new SignedError("INVALID_REQUEST", "Enter your name");
  if (input.theme !== undefined && !["system", "light", "dark"].includes(input.theme)) throw new SignedError("INVALID_REQUEST", "Theme must be system, light, or dark");
  await ctx.db.updateTable("users").set({ name, ...(input.theme ? { theme: input.theme } : {}) }).where("id", "=", actor.id).execute();
}

export async function userById(ctx: Ctx, id: string | null) {
  if (!id) return null;
  const u = await ctx.db.selectFrom("users").select(["id", "email", "name", "role", "status"]).where("id", "=", id).executeTakeFirst();
  return u ? { ...u, name: u.name || u.email.split("@")[0]! } : null;
}
