import { eventHashInput } from "@signed-md/core";
import { type Database, newId, now } from "@signed-md/db";
import type { Kysely, Transaction } from "kysely";
import { type Actor, actorRef } from "../context.ts";
import { sha256 } from "../crypto.ts";

export interface EventRecord {
  id: string;
  document_id: string;
  seq: number;
  type: string;
  actor: string;
  actor_label: string;
  created_at: string;
  data: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

/**
 * Append an event to a document's hash chain. Must run inside a transaction that holds the document lock,
 * so sequence numbers cannot race.
 */
export async function appendEvent(
  trx: Transaction<Database> | Kysely<Database>,
  documentId: string,
  type: string,
  actor: Actor,
  data: Record<string, unknown> = {},
): Promise<EventRecord> {
  const last = await trx
    .selectFrom("events")
    .select(["seq", "hash"])
    .where("document_id", "=", documentId)
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  const base = {
    document_id: documentId,
    seq: (last ? Number(last.seq) : 0) + 1,
    type,
    actor: actorRef(actor),
    actor_label: actor.label,
    created_at: now(),
    data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    prev_hash: last?.hash ?? null,
  };
  const hash = sha256(eventHashInput(base));
  const id = newId("evt");
  await trx
    .insertInto("events")
    .values({
      id,
      document_id: documentId,
      seq: base.seq,
      type,
      actor: base.actor,
      created_at: base.created_at,
      data: JSON.stringify({ ...base.data, _actor_label: base.actor_label }),
      prev_hash: base.prev_hash,
      hash,
    })
    .execute();
  return { id, ...base, hash };
}

export async function listEvents(db: Kysely<Database>, documentId: string): Promise<EventRecord[]> {
  const rows = await db.selectFrom("events").selectAll().where("document_id", "=", documentId).orderBy("seq").execute();
  return rows.map((r) => {
    const { _actor_label, ...data } = JSON.parse(r.data) as Record<string, unknown> & { _actor_label?: string };
    return {
      id: r.id,
      document_id: r.document_id,
      seq: Number(r.seq),
      type: r.type,
      actor: r.actor,
      actor_label: _actor_label ?? "",
      created_at: r.created_at,
      data,
      prev_hash: r.prev_hash,
      hash: r.hash,
    };
  });
}
