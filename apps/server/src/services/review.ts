import { SignedError, transition } from "@signed-md/core";
import { now } from "@signed-md/db";
import { type Ctx, SYSTEM } from "../context.ts";
import { activateNextGroup, loadSigners, lockDocument } from "./documents.ts";
import { appendEvent } from "./events.ts";

/**
 * Review of an account's first sends, for the hosted service (REVIEW_SENDS, off by default).
 *
 * A held document is sent (its revision, values and signers are frozen and it counts towards the
 * plan), but no signer is notified until an operator releases it. Operators work through the CLI:
 * `review list`, `review release <id>` and `review reject <id> [reason]`. When REVIEW_NOTIFY_URL is
 * set, the worker POSTs {"document_id"} there for each held document. The notice carries nothing
 * else and no secret: the receiver checks it by running `review list` itself.
 */

export interface HeldDocument {
  id: string;
  title: string;
  held_at: string;
  sent_by: string | null;
  message: string | null;
  signers: { name: string; email: string }[];
  /** The Markdown as sent, with template values filled in. */
  content: string;
}

export async function listHeld(ctx: Ctx): Promise<HeldDocument[]> {
  const docs = await ctx.db
    .selectFrom("documents")
    .leftJoin("users", "users.id", "documents.owner_user_id")
    .select(["documents.id", "documents.title", "documents.review_held_at", "documents.signer_message", "documents.content", "documents.approved_by", "users.email"])
    .where("documents.review_held_at", "is not", null)
    .orderBy("documents.review_held_at")
    .execute();
  const out: HeldDocument[] = [];
  for (const d of docs) {
    const signers = await loadSigners(ctx.db, d.id);
    out.push({
      id: d.id,
      title: d.title,
      held_at: d.review_held_at!,
      sent_by: d.email ?? d.approved_by,
      message: d.signer_message,
      signers: signers.map((s) => ({ name: s.name, email: s.email })),
      content: d.content ?? "",
    });
  }
  return out;
}

/** Notify the first signing group, as an ordinary send would have. The deadline starts now. */
export async function releaseHeld(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    if (!doc.review_held_at) throw new SignedError("INVALID_TRANSITION", `Document ${id} is not held for review`);
    const t = now();
    await trx
      .updateTable("documents")
      .set({ review_held_at: null, updated_at: t, expires_at: new Date(Date.now() + Number(doc.expires_in_days) * 86400_000).toISOString() })
      .where("id", "=", id)
      .execute();
    await appendEvent(trx, id, "document.review_released", SYSTEM);
    await activateNextGroup(ctx, trx, id);
  });
}

/** Revoke a held document. Nobody was notified, so nobody is emailed. */
export async function rejectHeld(ctx: Ctx, id: string, reason: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    if (!doc.review_held_at) throw new SignedError("INVALID_TRANSITION", `Document ${id} is not held for review`);
    const status = transition(doc.status, "revoke");
    const t = now();
    const why = reason.trim().slice(0, 1000) || "Stopped by Signed.md after review";
    await trx.updateTable("documents").set({ status, review_held_at: null, revoked_at: t, updated_at: t, revoke_reason: why }).where("id", "=", id).execute();
    await trx.updateTable("signers").set({ token_hash: null, link_sealed: null }).where("document_id", "=", id).execute();
    await appendEvent(trx, id, "document.revoked", SYSTEM, { reason: why, review: true });
  });
}

/** The worker's job: tell REVIEW_NOTIFY_URL a document is waiting. Throws to retry. */
export async function sendReviewNotice(ctx: Ctx, documentId: string): Promise<void> {
  const url = ctx.config.reviewNotifyUrl;
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document_id: documentId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`REVIEW_NOTIFY_URL answered ${res.status}`);
}
