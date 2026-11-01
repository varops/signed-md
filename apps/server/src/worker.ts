import { claimJob, completeJob, failJob } from "@signed-md/db";
import type { Ctx } from "./context.ts";
import { log } from "./log.ts";
import { type EmailJob, sendEmailJob } from "./services/emails.ts";
import { finalizeDocument } from "./services/finalize.ts";
import { expireDocuments } from "./services/signing.ts";
import { deliverWebhook, markWebhookFailed } from "./services/webhooks.ts";

type Handler = (ctx: Ctx, payload: any) => Promise<void>;

const handlers: Record<string, Handler> = {
  email: (ctx, p: EmailJob) => sendEmailJob(ctx, p),
  webhook: (ctx, p: { delivery_id: string }) => deliverWebhook(ctx, p.delivery_id),
  finalize: (ctx, p: { document_id: string }) => finalizeDocument(ctx, p.document_id),
};

/** Run one due job, if any. Returns true when a job ran. */
export async function runOneJob(ctx: Ctx): Promise<boolean> {
  const job = await claimJob(ctx.db, ctx.dialect);
  if (!job) return false;
  const handler = handlers[job.type];
  const payload = JSON.parse(job.payload);
  try {
    if (!handler) throw new Error(`No handler for job type '${job.type}'`);
    await handler(ctx, payload);
    await completeJob(ctx.db, job.id);
    log.debug("job done", { id: job.id, type: job.type });
  } catch (err) {
    const outcome = await failJob(ctx.db, job, (err as Error).stack ?? String(err));
    log.warn("job failed", { id: job.id, type: job.type, attempt: Number(job.attempts), outcome, error: (err as Error).message });
    if (outcome === "failed" && job.type === "webhook") await markWebhookFailed(ctx, payload.delivery_id);
  }
  return true;
}

/** Run jobs until none are due. Used by tests and the demo. */
export async function drainJobs(ctx: Ctx, max = 1000): Promise<number> {
  let n = 0;
  while (n < max && (await runOneJob(ctx))) n++;
  return n;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** In-process worker loop. Also sweeps expired documents every minute. */
export function startWorker(ctx: Ctx): WorkerHandle {
  let stopped = false;
  let lastSweep = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastSweep > 60_000) {
          lastSweep = Date.now();
          const n = await expireDocuments(ctx);
          if (n) log.info("expired documents", { count: n });
        }
        const ran = await runOneJob(ctx);
        if (!ran) await new Promise((r) => setTimeout(r, ctx.config.workerIntervalMs));
      } catch (err) {
        log.error("worker loop error", { error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}
