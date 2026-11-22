import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentMachine } from "@signed-md/core";
import type { Ctx } from "../context.ts";
import { log } from "../log.ts";
import { nextReminderAt } from "./reminders.ts";

/** File in DATA_DIR that holds the next time the worker has work: an ISO timestamp, or empty. */
export const NEXT_WORK_FILE = "next-work-at";

/**
 * When the background worker next has something to do: a due or retried job, a document to expire,
 * or a reminder. Returns `at` when work is already due, and null when nothing is planned.
 *
 * Platforms that stop idle instances (scale to zero) use it to start the instance again in time.
 * The result may be early, never late: the worker decides what to do when it runs.
 */
export async function nextWorkAt(ctx: Ctx, at: Date = new Date()): Promise<Date | null> {
  const times: number[] = [];
  const now = at.toISOString();

  const job = await ctx.db
    .selectFrom("jobs")
    .select((eb) => eb.fn.min("run_at").as("t"))
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (job?.t) times.push(Date.parse(String(job.t)));
  // A job whose worker died is retried when its lock runs out.
  const stuck = await ctx.db
    .selectFrom("jobs")
    .select((eb) => eb.fn.min("locked_until").as("t"))
    .where("status", "=", "running")
    .executeTakeFirst();
  if (stuck?.t) times.push(Date.parse(String(stuck.t)));

  const expiring = await ctx.db
    .selectFrom("documents")
    .select((eb) => eb.fn.min("expires_at").as("t"))
    .where("status", "in", documentMachine.sources("expire"))
    .where("expires_at", "is not", null)
    .executeTakeFirst();
  if (expiring?.t) times.push(Date.parse(String(expiring.t)));

  const rows = await ctx.db
    .selectFrom("signers")
    .innerJoin("documents", "documents.id", "signers.document_id")
    .select([
      "signers.status",
      "signers.token_hash",
      "signers.notified_at",
      "signers.last_reminded_at",
      "signers.deadline_reminders",
      "documents.timezone",
      "documents.expires_at",
    ])
    .where("documents.reminders", "=", 1)
    .where("documents.status", "in", documentMachine.sources("sign"))
    .where("documents.expires_at", ">", now)
    .where("signers.token_hash", "is not", null)
    .execute();
  for (const r of rows) {
    const next = nextReminderAt(r, r, at);
    if (next) times.push(next.getTime());
  }

  if (!times.length) return null;
  return new Date(Math.max(Math.min(...times), at.getTime()));
}

/**
 * Write the next work time to DATA_DIR/next-work-at, only when it changed. A disabled account
 * (ACTIVE=false) runs no worker, so it writes an empty file. Never throws: a failed write is logged.
 */
export async function writeNextWorkAt(ctx: Ctx, previous: string | null = null): Promise<string | null> {
  try {
    const next = ctx.config.active ? await nextWorkAt(ctx) : null;
    const text = next ? next.toISOString() : "";
    if (text === previous) return text;
    const file = join(ctx.config.dataDir, NEXT_WORK_FILE);
    writeFileSync(`${file}.tmp`, text ? `${text}\n` : "");
    renameSync(`${file}.tmp`, file);
    return text;
  } catch (err) {
    log.warn("could not write the next work time", { error: (err as Error).message });
    return previous;
  }
}
