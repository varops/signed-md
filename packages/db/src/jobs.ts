import { type Kysely, sql } from "kysely";
import type { Dialect } from "./connect.ts";
import { newId, now } from "./ids.ts";
import type { Database, JobTable } from "./schema.ts";

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Jobs with the same dedupe key are only enqueued once. */
  dedupeKey?: string;
}

export async function enqueueJob(
  db: Kysely<Database>,
  type: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<string | null> {
  const id = newId("job");
  const res = await db
    .insertInto("jobs")
    .values({
      id,
      type,
      payload: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      max_attempts: opts.maxAttempts ?? 8,
      run_at: (opts.runAt ?? new Date()).toISOString(),
      locked_until: null,
      last_error: null,
      dedupe_key: opts.dedupeKey ?? null,
      created_at: now(),
      finished_at: null,
    })
    .onConflict((oc) => oc.column("dedupe_key").doNothing())
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0 ? id : null;
}

/**
 * Claim the next due job. Running jobs whose lock expired (for example after a crash) are claimed again.
 * SQLite uses a single atomic UPDATE; PostgreSQL adds FOR UPDATE SKIP LOCKED for concurrent workers.
 */
export async function claimJob(
  db: Kysely<Database>,
  dialect: Dialect,
  lockSeconds = 300,
): Promise<JobTable | null> {
  const t = now();
  const lockUntil = new Date(Date.now() + lockSeconds * 1000).toISOString();
  const lock = dialect === "postgres" ? sql`for update skip locked` : sql``;
  const result = await sql<JobTable>`
    update jobs
       set status = 'running', locked_until = ${lockUntil}, attempts = attempts + 1
     where id = (
       select id from jobs
        where (status = 'pending' and run_at <= ${t})
           or (status = 'running' and locked_until < ${t})
        order by run_at
        limit 1
        ${lock}
     )
    returning *`.execute(db);
  return result.rows[0] ?? null;
}

export async function completeJob(db: Kysely<Database>, id: string): Promise<void> {
  await db.updateTable("jobs").set({ status: "done", finished_at: now(), locked_until: null }).where("id", "=", id).execute();
}

/** Record a failure and schedule a retry with exponential backoff, or mark the job failed. */
export async function failJob(db: Kysely<Database>, job: JobTable, error: string): Promise<"retry" | "failed"> {
  if (job.attempts >= job.max_attempts) {
    await db
      .updateTable("jobs")
      .set({ status: "failed", last_error: error.slice(0, 2000), finished_at: now(), locked_until: null })
      .where("id", "=", job.id)
      .execute();
    return "failed";
  }
  const delay = Math.min(2 ** job.attempts * 15, 6 * 3600) * 1000; // 30s, 60s, 2m, ... capped at 6h
  await db
    .updateTable("jobs")
    .set({
      status: "pending",
      last_error: error.slice(0, 2000),
      run_at: new Date(Date.now() + delay).toISOString(),
      locked_until: null,
    })
    .where("id", "=", job.id)
    .execute();
  return "retry";
}
