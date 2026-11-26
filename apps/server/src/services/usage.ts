import { SignedError } from "@signed-md/core";
import type { Database } from "@signed-md/db";
import { type Kysely, sql } from "kysely";
import type { Ctx } from "../context.ts";

/**
 * Plan limits on sent contracts, for the hosted service. MONTHLY_LIMIT and TOTAL_LIMIT default to
 * -1 (no limit), so self-hosted installations never hit them. Each sent contract adds one to the
 * counter for its calendar month (UTC).
 */

/** The current calendar month, YYYY-MM, in UTC. */
export function currentPeriod(at = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export interface Usage {
  month: number;
  total: number;
}

export async function getUsage(db: Kysely<Database>): Promise<Usage> {
  const rows = await db.selectFrom("usage_counters").select(["period", "sent"]).execute();
  const period = currentPeriod();
  return {
    month: Number(rows.find((r) => r.period === period)?.sent ?? 0),
    total: rows.reduce((sum, r) => sum + Number(r.sent), 0),
  };
}

export interface LimitHit {
  kind: "monthly" | "total";
  limit: number;
  /** For people: what happened, without the link. */
  summary: string;
  /** For API and MCP clients: the summary and the upgrade link. */
  message: string;
  url: string;
}

/** Where to upgrade. app.signed.md shows the right plans for this workspace and user. */
export function upgradeUrl(ctx: Ctx, reason: "limit" | "usage" = "limit"): string {
  return `${ctx.config.hostedAppUrl}/billing?${new URLSearchParams({ reason, workspace: new URL(ctx.config.publicUrl).host })}`;
}

export interface Remaining {
  kind: "monthly" | "total";
  limit: number;
  left: number;
  /** For the counter's colour: plenty left, running low, or none left. */
  level: "ok" | "low" | "out";
  url: string;
}

/** Contracts left under the tightest limit, or null when there are no limits (self-hosted). */
export async function remaining(ctx: Ctx): Promise<Remaining | null> {
  const { monthlyLimit, totalLimit } = ctx.config;
  if (monthlyLimit < 0 && totalLimit < 0) return null;
  const usage = await getUsage(ctx.db);
  const options: { kind: Remaining["kind"]; limit: number; left: number }[] = [];
  if (totalLimit >= 0) options.push({ kind: "total", limit: totalLimit, left: Math.max(0, totalLimit - usage.total) });
  if (monthlyLimit >= 0) options.push({ kind: "monthly", limit: monthlyLimit, left: Math.max(0, monthlyLimit - usage.month) });
  const tightest = options.reduce((a, b) => (b.left < a.left ? b : a));
  const level = tightest.left === 0 ? "out" : tightest.left <= 2 || tightest.left < tightest.limit * 0.2 ? "low" : "ok";
  return { ...tightest, level, url: upgradeUrl(ctx, level === "out" ? "limit" : "usage") };
}

/** The limit this workspace has reached, if any. */
export async function limitReached(ctx: Ctx, db: Kysely<Database> = ctx.db): Promise<LimitHit | null> {
  const { monthlyLimit, totalLimit } = ctx.config;
  if (monthlyLimit < 0 && totalLimit < 0) return null;
  const usage = await getUsage(db);
  const url = upgradeUrl(ctx);
  const plural = (n: number) => `${n} contract${n === 1 ? "" : "s"}`;
  const hit = (kind: LimitHit["kind"], limit: number, summary: string): LimitHit => ({ kind, limit, url, summary, message: `${summary} Upgrade to send more: ${url}` });
  if (totalLimit >= 0 && usage.total >= totalLimit) return hit("total", totalLimit, `This workspace has used all ${plural(totalLimit)} in its plan.`);
  if (monthlyLimit >= 0 && usage.month >= monthlyLimit) return hit("monthly", monthlyLimit, `This workspace has sent its ${plural(monthlyLimit)} for this month.`);
  return null;
}

export async function requireUnderLimit(ctx: Ctx, db: Kysely<Database> = ctx.db): Promise<void> {
  const hit = await limitReached(ctx, db);
  if (hit) throw new SignedError("LIMIT_REACHED", hit.message);
}

/** Add one sent contract to this month's counter. Call inside the sending transaction. */
export async function countSent(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto("usage_counters")
    .values({ period: currentPeriod(), sent: 1 })
    .onConflict((oc) => oc.column("period").doUpdateSet({ sent: sql`usage_counters.sent + 1` }))
    .execute();
}
