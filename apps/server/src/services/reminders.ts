import { addBusinessDays, documentMachine, isBusinessDay, signerMachine } from "@signed-md/core";
import { enqueueJob } from "@signed-md/db";
import type { Ctx } from "../context.ts";
import { issueToken, loadSigners, lockDocument } from "./documents.ts";
import { appendEvent } from "./events.ts";

/** Business days between reminders. */
export const REMINDER_INTERVAL_DAYS = 3;

/**
 * Reminders before the deadline: 24 hours and 1 hour before it. `stage` is stored in
 * `signers.deadline_reminders`, so each one goes out once.
 */
export const DEADLINE_REMINDERS = [
  { stage: 1, hours: 24 },
  { stage: 2, hours: 1 },
] as const;

/**
 * Regular reminders stop 4 days before the deadline, so the 24-hour one never follows a regular
 * one a day later.
 */
export const QUIET_BEFORE_DEADLINE_DAYS = 4;

const HOUR = 3_600_000;
const SYSTEM = { kind: "system", id: "system", label: "Signed.md" } as const;

type SignerState = {
  status: string;
  token_hash: string | null;
  notified_at: string | null;
  last_reminded_at: string | null;
  deadline_reminders: number;
};

/** A reminder that is due now: a regular one (`hours` null) or one before the deadline. */
export type DueReminder = { stage: number; hours: number | null };

/**
 * Automatic reminders. A signer who has a link and hasn't signed gets:
 *
 * - a reminder every 3 business days (Monday to Friday in the document's timezone), counted from
 *   their signing email or their last reminder, manual or automatic. These only go out on business
 *   days, and only while the deadline is at least 4 days away;
 * - a reminder 24 hours and 1 hour before the deadline, on any day. Each is skipped when the signer
 *   first heard from us after it was due (a document sent with less than 24 hours left gets no
 *   24-hour reminder).
 *
 * Reminders reuse the signer's link, so earlier emails keep working. Run by the worker every minute.
 * An instance that was asleep catches up with one reminder per signer, never a burst. Returns the
 * number of reminders queued.
 */
export async function sendReminders(ctx: Ctx, at: Date = new Date()): Promise<number> {
  const docs = await ctx.db
    .selectFrom("documents")
    .select(["id", "timezone", "expires_at"])
    .where("reminders", "=", 1)
    .where("status", "in", documentMachine.sources("sign"))
    .where("expires_at", ">", at.toISOString())
    .execute();
  let sent = 0;
  for (const d of docs) {
    const signers = await loadSigners(ctx.db, d.id);
    for (const s of signers) {
      if (!dueReminder(s, d, at)) continue;
      const done = await ctx.db.transaction().execute(async (trx) => {
        const doc = await lockDocument(ctx, trx, d.id);
        if (!Number(doc.reminders) || !documentMachine.can(doc.status, "sign")) return false;
        const fresh = (await loadSigners(trx, d.id)).find((x) => x.id === s.id);
        const due = fresh ? dueReminder(fresh, doc, at) : null;
        if (!fresh || !due) return false;
        const deadlineStage = due.hours === null ? {} : { deadline_reminders: due.stage };
        // Documents sent before reminders existed have no stored link: send a new one instead.
        if (!fresh.link_sealed) {
          await issueToken(ctx, trx, d.id, fresh, "reminder", due.hours);
          if (due.hours !== null) await trx.updateTable("signers").set(deadlineStage).where("id", "=", fresh.id).execute();
          return true;
        }
        const number = Number(fresh.reminders_sent) + 1;
        const res = await trx
          .updateTable("signers")
          .set({ reminders_sent: number, last_reminded_at: at.toISOString(), ...deadlineStage })
          .where("id", "=", fresh.id)
          .where("reminders_sent", "=", fresh.reminders_sent)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) return false;
        await appendEvent(trx, d.id, "signer.reminded", SYSTEM, {
          signer: fresh.key,
          email: fresh.email,
          reminder: number,
          ...(due.hours !== null ? { hours_before_expiry: due.hours } : {}),
        });
        await enqueueJob(trx, "email", {
          kind: "reminder",
          document_id: d.id,
          signer_id: fresh.id,
          link: fresh.link_sealed,
          reminder: number,
          new_link: false,
          ...(due.hours !== null ? { expires_in_hours: due.hours } : {}),
        });
        return true;
      });
      if (done) sent++;
    }
  }
  return sent;
}

/** The reminder this signer should get at `at`, or null when none is due. */
export function dueReminder(s: SignerState, doc: { timezone: string; expires_at: string | null }, at: Date): DueReminder | null {
  if (!signerMachine.can(s.status as never, "sign") || !s.token_hash) return null;
  const lastContact = latest(s.notified_at, s.last_reminded_at);
  if (!lastContact) return null;
  const t = at.getTime();
  if (doc.expires_at) {
    const end = Date.parse(doc.expires_at);
    if (t >= end) return null;
    // The latest window that has opened wins, so a sleeping instance skips straight to the 1-hour one.
    for (const r of [...DEADLINE_REMINDERS].reverse()) {
      const from = end - r.hours * HOUR;
      if (t < from) continue;
      if (Number(s.deadline_reminders) >= r.stage || lastContact >= from) return null;
      return { stage: r.stage, hours: r.hours };
    }
    if (t > end - QUIET_BEFORE_DEADLINE_DAYS * 24 * HOUR) return null;
  }
  if (!isBusinessDay(at, doc.timezone)) return null;
  const next = addBusinessDays(new Date(lastContact), REMINDER_INTERVAL_DAYS, doc.timezone);
  return next.getTime() <= t ? { stage: 0, hours: null } : null;
}

/**
 * The earliest moment a reminder could be due for this signer, at or after `at`, or null when none
 * will be. `sendReminders` decides at that moment, so this may be early, never late.
 */
export function nextReminderAt(s: SignerState, doc: { timezone: string; expires_at: string | null }, at: Date): Date | null {
  if (!signerMachine.can(s.status as never, "sign") || !s.token_hash) return null;
  const lastContact = latest(s.notified_at, s.last_reminded_at);
  if (!lastContact) return null;
  const t = at.getTime();
  const end = doc.expires_at ? Date.parse(doc.expires_at) : null;
  if (end !== null && t >= end) return null;
  const candidates: number[] = [];
  if (end !== null) {
    for (const r of DEADLINE_REMINDERS) {
      const from = end - r.hours * HOUR;
      if (Number(s.deadline_reminders) < r.stage && lastContact < from) candidates.push(Math.max(from, t));
    }
  }
  // A regular reminder that is overdue waits for the next business day in the document's timezone.
  let regular = Math.max(addBusinessDays(new Date(lastContact), REMINDER_INTERVAL_DAYS, doc.timezone).getTime(), t);
  while (!isBusinessDay(new Date(regular), doc.timezone)) regular += HOUR;
  if (end === null || regular <= end - QUIET_BEFORE_DEADLINE_DAYS * 24 * HOUR) candidates.push(regular);
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

function latest(a: string | null, b: string | null): number | null {
  const times = [a, b].filter((x): x is string => x !== null).map(Date.parse);
  return times.length ? Math.max(...times) : null;
}
