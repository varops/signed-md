import { type Database, newId, now } from "@signed-md/db";
import type { Kysely } from "kysely";
import { type Actor, actorRef } from "../context.ts";

/** Record a team, settings, or template event for the activity history. */
export async function recordAudit(db: Kysely<Database>, actor: Actor, type: string, data: Record<string, unknown> = {}): Promise<void> {
  const account = await db.selectFrom("accounts").select("id").limit(1).executeTakeFirst();
  await db
    .insertInto("audit_events")
    .values({
      id: newId("aud"),
      account_id: account?.id ?? "",
      actor: actorRef(actor),
      actor_label: actor.kind === "user" ? actor.name || actor.label : actor.kind === "apikey" ? `${actor.userName} (API key “${actor.label}”)` : actor.label,
      type,
      data: JSON.stringify(data),
      created_at: now(),
    })
    .execute();
}

export interface ActivityItem {
  at: string;
  actor: string;
  type: string;
  summary: string;
  document?: { id: string; title: string };
}

const DOC_TYPES: Record<string, string> = {
  "document.created": "created a draft",
  "document.updated": "edited the draft",
  "document.approved": "approved sending",
  "document.sent": "sent for signature",
  "document.revoked": "revoked",
  "document.archived": "archived",
  "document.unarchived": "unarchived",
  "document.inline_approved": "approved the inline document",
  "signer.viewed": "opened",
  "signer.signed": "signed",
  "signer.declined": "declined",
  "signer.link_resent": "resent a signing link",
  "document.signed": "everyone signed",
  "document.finalized": "package ready",
  "document.expired": "expired",
};

const AUDIT_TYPES: Record<string, (d: Record<string, unknown>) => string> = {
  "team.invited": (d) => `invited ${d.email} as ${d.role}`,
  "team.invite_revoked": (d) => `revoked the invitation for ${d.email}`,
  "team.invite_resent": (d) => `resent the invitation to ${d.email}`,
  "team.joined": (d) => `joined as ${d.role}`,
  "team.role_changed": (d) => `changed ${d.email}'s role from ${d.from} to ${d.to}`,
  "team.deactivated": (d) => `deactivated ${d.email}`,
  "team.reactivated": (d) => `reactivated ${d.email}`,
  "settings.updated": (d) => `updated settings (${(d.sections as string[] | undefined)?.join(", ") ?? "account"})`,
  "apikey.created": (d) => `created API key “${d.label}”`,
  "apikey.revoked": (d) => `revoked API key “${d.label}”`,
  "template.created": (d) => `created template “${d.name}”`,
  "template.version_created": (d) => `created version ${d.version} of “${d.name}”`,
  "template.approved": (d) => `approved version ${d.version} of “${d.name}”`,
  "template.archived": (d) => `archived template “${d.name}”`,
  "template.unarchived": (d) => `unarchived template “${d.name}”`,
};

/** Recent team and document activity, newest first. */
export async function listActivity(db: Kysely<Database>, limit = 100): Promise<ActivityItem[]> {
  const audit = await db.selectFrom("audit_events").selectAll().orderBy("created_at", "desc").limit(limit).execute();
  const docEvents = await db
    .selectFrom("events")
    .innerJoin("documents", "documents.id", "events.document_id")
    .select(["events.type", "events.data", "events.created_at", "events.document_id", "documents.title"])
    .where("events.type", "in", Object.keys(DOC_TYPES))
    .orderBy("events.created_at", "desc")
    .limit(limit)
    .execute();
  const items: ActivityItem[] = [
    ...audit.map((a) => {
      const d = JSON.parse(a.data) as Record<string, unknown>;
      return { at: a.created_at, actor: a.actor_label, type: a.type, summary: AUDIT_TYPES[a.type]?.(d) ?? a.type };
    }),
    ...docEvents.map((e) => {
      const d = JSON.parse(e.data) as Record<string, unknown> & { _actor_label?: string };
      return { at: e.created_at, actor: d._actor_label ?? "", type: e.type, summary: DOC_TYPES[e.type] ?? e.type, document: { id: e.document_id, title: e.title } };
    }),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
