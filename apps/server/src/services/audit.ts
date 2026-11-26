import { type Database, newId, now } from "@signed-md/db";
import type { ExpressionBuilder, Kysely } from "kysely";
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
  "document.held_for_review": "held it for review",
  "document.review_released": "released it after review",
  "document.archived": "archived",
  "document.unarchived": "unarchived",
  "document.inline_approved": "approved the inline document",
  "document.send_approved": "approved it for the agent to send",
  "document.converted_to_inline": "turned a template draft into an inline document to edit its text",
  "signer.viewed": "opened",
  "signer.downloaded_review_copy": "downloaded a copy for review",
  "signer.signed": "signed",
  "signer.declined": "declined",
  "signer.link_resent": "resent a signing link",
  "signer.reminded": "sent a reminder",
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
  "password.reset": () => "reset their password with an emailed link",
  "folder.created": (d) => `created the ${d.kind} folder “${d.name}”`,
  "folder.renamed": (d) => `renamed the ${d.kind} folder “${d.from}” to “${d.name}”`,
  "folder.deleted": (d) => `deleted the ${d.kind} folder “${d.name}”${d.moved ? ` (${d.moved} moved to the top level)` : ""}`,
};

/** A page of activity, newest first, with cursors for the older and newer pages (null at either end). */
export interface ActivityPage {
  items: ActivityItem[];
  older: string | null;
  newer: string | null;
}

/**
 * Team and document activity, newest first, a page at a time. It merges two tables, so each row's
 * position is its time plus a key ("a:" audit id, "e:" event id); the cursor is "time|key". A newer page
 * that would come up short is the first page instead.
 */
export async function listActivity(db: Kysely<Database>, opts: { limit?: number; before?: string; after?: string } = {}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const newer = !opts.before && !!opts.after;
  const cursor = opts.before ?? opts.after;
  const c = cursor ? { at: cursor.slice(0, cursor.indexOf("|")), key: cursor.slice(cursor.indexOf("|") + 1) } : null;
  const op = newer ? ">" : "<";
  const dir = newer ? "asc" : "desc";
  // Past the cursor, for one table: an earlier (or later) time, or the same time and a key past the cursor's.
  // At the cursor's own time, rows of the other table are all past it or none are ("a:" sorts before "e:").
  const past = (prefix: "a:" | "e:", at: "created_at" | "events.created_at", id: "id" | "events.id") => (eb: ExpressionBuilder<any, any>) => {
    if (!c) return eb(at, "is not", null);
    if (c.key.slice(0, 2) === prefix) return eb.or([eb(at, op, c.at), eb.and([eb(at, "=", c.at), eb(id, op, c.key.slice(2))])]);
    const sameTimeToo = newer ? prefix > c.key.slice(0, 2) : prefix < c.key.slice(0, 2);
    return eb(at, sameTimeToo ? (newer ? ">=" : "<=") : op, c.at);
  };
  const audit = await db.selectFrom("audit_events").selectAll().where((eb) => past("a:", "created_at", "id")(eb)).orderBy("created_at", dir).orderBy("id", dir).limit(limit + 1).execute();
  const docEvents = await db
    .selectFrom("events")
    .innerJoin("documents", "documents.id", "events.document_id")
    .select(["events.id", "events.type", "events.data", "events.created_at", "events.document_id", "documents.title"])
    .where("events.type", "in", Object.keys(DOC_TYPES))
    .where((eb) => past("e:", "events.created_at", "events.id")(eb))
    .orderBy("events.created_at", dir)
    .orderBy("events.id", dir)
    .limit(limit + 1)
    .execute();
  const rows: (ActivityItem & { key: string })[] = [
    ...audit.map((a) => {
      const d = JSON.parse(a.data) as Record<string, unknown>;
      return { key: `a:${a.id}`, at: a.created_at, actor: a.actor_label, type: a.type, summary: AUDIT_TYPES[a.type]?.(d) ?? a.type };
    }),
    ...docEvents.map((e) => {
      const d = JSON.parse(e.data) as Record<string, unknown> & { _actor_label?: string };
      return { key: `e:${e.id}`, at: e.created_at, actor: d._actor_label ?? "", type: e.type, summary: DOC_TYPES[e.type] ?? e.type, document: { id: e.document_id, title: e.title } };
    }),
  ];
  const sign = newer ? 1 : -1;
  rows.sort((x, y) => sign * (x.at < y.at ? -1 : x.at > y.at ? 1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const more = rows.length > limit;
  if (newer && !more) return listActivity(db, { limit });
  const page = newer ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
  const pos = (r: { at: string; key: string } | undefined) => (r ? `${r.at}|${r.key}` : null);
  return {
    items: page.map(({ key: _key, ...item }) => item),
    older: newer || more ? pos(page[page.length - 1]) : null,
    newer: newer || cursor ? pos(page[0]) : null,
  };
}
