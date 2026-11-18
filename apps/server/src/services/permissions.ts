import { SignedError } from "@signed-md/core";
import type { Actor, Role } from "../context.ts";

/**
 * Every permission check goes through this module. REST, MCP, and the web UI all call the same
 * services, and the services call `requirePermission` / `canManageDocument` / `canReadDocument`.
 */
export type Permission =
  | "documents.create"
  /** See every document, not just your own. */
  | "documents.read_all"
  /** Edit, send, revoke, archive any document. */
  | "documents.manage_all"
  | "templates.create"
  /** Archive and unarchive templates. */
  | "templates.manage"
  /** Approve template versions. Owners only, and only in the web UI. */
  | "templates.approve"
  /** Approve inline documents when the account requires it. Owners only. */
  | "inline.approve"
  /** Account settings, SMTP, webhooks, branding. */
  | "settings.manage"
  /** Invite, change roles, deactivate. */
  | "team.manage"
  /** See and revoke everyone's API keys. */
  | "keys.manage_all"
  | "activity.read";

const ALL: Permission[] = [
  "documents.create", "documents.read_all", "documents.manage_all", "templates.create", "templates.manage",
  "templates.approve", "inline.approve", "settings.manage", "team.manage", "keys.manage_all", "activity.read",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ALL),
  admin: new Set(ALL.filter((p) => p !== "templates.approve" && p !== "inline.approve")),
  member: new Set(["documents.create", "templates.create"]),
  viewer: new Set(["documents.read_all", "activity.read"]),
};

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Administrator", member: "Member", viewer: "Viewer" };
export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

/**
 * ACTIVE=false (hosted service, after cancellation): the account is read-only. Only owners can
 * log in or use their API keys, and only to view and download. Signers can still finish documents
 * already sent, and the worker keeps running. Not documented on purpose.
 */
let accountActive = true;

export function setAccountActive(active: boolean): void {
  accountActive = active;
}

export function isAccountActive(): boolean {
  return accountActive;
}

export const ACCOUNT_DISABLED = "This account is disabled. Owners can still log in to view and download documents.";

/** Permissions an owner keeps while the account is disabled. */
const READ_ONLY: ReadonlySet<Permission> = new Set(["documents.read_all", "activity.read"]);

export function roleOf(actor: Actor): Role | null {
  return actor.kind === "user" || actor.kind === "apikey" ? actor.role : null;
}

/** The person behind the actor: the user, or the user who owns the API key. */
export function userIdOf(actor: Actor): string | null {
  if (actor.kind === "user") return actor.id;
  if (actor.kind === "apikey") return actor.userId;
  return null;
}

export function can(actor: Actor, permission: Permission): boolean {
  if (actor.kind === "system") return true;
  const role = roleOf(actor);
  if (role === null) return false;
  if (!accountActive) return role === "owner" && READ_ONLY.has(permission);
  return ROLE_PERMISSIONS[role].has(permission);
}

const MESSAGES: Partial<Record<Permission, string>> = {
  "templates.approve": "Only an owner can approve templates, in the Signed.md web UI.",
  "inline.approve": "Only an owner can approve inline documents, in the Signed.md web UI.",
  "settings.manage": "Only owners and administrators can change account settings.",
  "team.manage": "Only owners and administrators can manage the team.",
  "documents.create": "Viewers can't create documents.",
  "templates.create": "Viewers can't create templates.",
  "templates.manage": "Only owners and administrators can archive templates.",
};

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    if (!accountActive && roleOf(actor) !== null) throw new SignedError("PERMISSION_DENIED", ACCOUNT_DISABLED);
    throw new SignedError("PERMISSION_DENIED", MESSAGES[permission] ?? "You don't have permission to do this.");
  }
}

export function canReadDocument(actor: Actor, doc: { owner_user_id: string | null }): boolean {
  return can(actor, "documents.read_all") || can(actor, "documents.manage_all") || (doc.owner_user_id !== null && doc.owner_user_id === userIdOf(actor));
}

export function canManageDocument(actor: Actor, doc: { owner_user_id: string | null }): boolean {
  if (can(actor, "documents.manage_all")) return true;
  return can(actor, "documents.create") && doc.owner_user_id !== null && doc.owner_user_id === userIdOf(actor);
}

/** Documents you can't read are reported as not found, so IDs don't leak. */
export function requireReadDocument(actor: Actor, doc: { id: string; owner_user_id: string | null }): void {
  if (!canReadDocument(actor, doc)) throw new SignedError("DOCUMENT_NOT_FOUND", `Document ${doc.id} does not exist`);
}

export function requireManageDocument(actor: Actor, doc: { id: string; owner_user_id: string | null }): void {
  requireReadDocument(actor, doc);
  if (!canManageDocument(actor, doc) && !accountActive) throw new SignedError("PERMISSION_DENIED", ACCOUNT_DISABLED);
  if (!canManageDocument(actor, doc)) throw new SignedError("PERMISSION_DENIED", "Only the document's owner or an administrator can change it.");
}
