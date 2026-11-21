import { addBusinessDays, documentMachine, isBusinessDay, signerMachine } from "@signed-md/core";
import { enqueueJob } from "@signed-md/db";
import type { Ctx } from "../context.ts";
import { issueToken, loadSigners, lockDocument } from "./documents.ts";
import { appendEvent } from "./events.ts";

/** Business days between reminders. */
export const REMINDER_INTERVAL_DAYS = 3;

const SYSTEM = { kind: "system", id: "system", label: "Signed.md" } as const;

/**
 * Automatic reminders. A signer who has a link and hasn't signed gets a reminder every 3 business
 * days (Monday to Friday in the document's timezone), counted from their signing email or their last
 * reminder, manual or automatic. Reminders reuse the signer's link, so earlier emails keep working.
 * Run by the worker every minute. An instance that was asleep catches up with one reminder per
 * signer, never a burst. Returns the number of reminders queued.
 */
export async function sendReminders(ctx: Ctx, at: Date = new Date()): Promise<number> {
  const docs = await ctx.db
    .selectFrom("documents")
    .select(["id", "timezone"])
    .where("reminders", "=", 1)
    .where("status", "in", documentMachine.sources("sign"))
    .where("expires_at", ">", at.toISOString())
    .execute();
  let sent = 0;
  for (const d of docs) {
    // Reminders only go out on business days, also when a sleeping instance wakes on a weekend.
    if (!isBusinessDay(at, d.timezone)) continue;
    const signers = await loadSigners(ctx.db, d.id);
    for (const s of signers) {
      if (!isDue(s, d.timezone, at)) continue;
      const done = await ctx.db.transaction().execute(async (trx) => {
        const doc = await lockDocument(ctx, trx, d.id);
        if (!Number(doc.reminders) || !documentMachine.can(doc.status, "sign")) return false;
        const fresh = (await loadSigners(trx, d.id)).find((x) => x.id === s.id);
        if (!fresh || !isDue(fresh, doc.timezone, at)) return false;
        // Documents sent before reminders existed have no stored link: send a new one instead.
        if (!fresh.link_sealed) {
          await issueToken(ctx, trx, d.id, fresh, "reminder");
          return true;
        }
        const number = Number(fresh.reminders_sent) + 1;
        const res = await trx
          .updateTable("signers")
          .set({ reminders_sent: number, last_reminded_at: at.toISOString() })
          .where("id", "=", fresh.id)
          .where("reminders_sent", "=", fresh.reminders_sent)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) return false;
        await appendEvent(trx, d.id, "signer.reminded", SYSTEM, { signer: fresh.key, email: fresh.email, reminder: number });
        await enqueueJob(trx, "email", {
          kind: "reminder",
          document_id: d.id,
          signer_id: fresh.id,
          link: fresh.link_sealed,
          reminder: number,
          new_link: false,
        });
        return true;
      });
      if (done) sent++;
    }
  }
  return sent;
}

/** When this signer's next automatic reminder is due, or null when they don't get one. */
export function nextReminderAt(
  s: { status: string; token_hash: string | null; notified_at: string | null; last_reminded_at: string | null },
  timeZone: string,
): Date | null {
  if (!signerMachine.can(s.status as never, "sign") || !s.token_hash) return null;
  const since = s.last_reminded_at ?? s.notified_at;
  return since ? addBusinessDays(new Date(since), REMINDER_INTERVAL_DAYS, timeZone) : null;
}

function isDue(s: Parameters<typeof nextReminderAt>[0], timeZone: string, at: Date): boolean {
  const due = nextReminderAt(s, timeZone);
  return due !== null && due.getTime() <= at.getTime();
}
