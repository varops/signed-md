import { lookup } from "node:dns";
import { isIP } from "node:net";
import { deliveryMachine, SignedError } from "@signed-md/core";
import { type Database, enqueueJob, newId, now } from "@signed-md/db";
import type { Kysely, Transaction } from "kysely";
import { Agent, fetch } from "undici";
import type { Ctx } from "../context.ts";
import { hmacHex } from "../crypto.ts";
import { getAccount } from "./accounts.ts";

export type WebhookEventType =
  | "document.awaiting_last_signer"
  | "document.signed"
  | "document.finalized"
  | "document.declined";

/** Checks that do not need the network: scheme, credentials, obvious internal hosts. */
export function assertWebhookUrlShape(ctx: Ctx, url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SignedError("INVALID_REQUEST", "Webhook URL is not a valid URL", [{ code: "INVALID_REQUEST", field: "webhook_url", message: "Invalid URL" }]);
  }
  const insecure = ctx.config.allowInsecureWebhooks;
  if (u.protocol !== "https:" && !(insecure && u.protocol === "http:")) {
    throw new SignedError("INVALID_REQUEST", "Webhook URL must use https", [{ code: "INVALID_REQUEST", field: "webhook_url", message: "Must be https" }]);
  }
  if (u.username || u.password) {
    throw new SignedError("INVALID_REQUEST", "Webhook URL must not contain credentials", [{ code: "INVALID_REQUEST", field: "webhook_url", message: "No credentials" }]);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!insecure && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || (isIP(host) && isPrivateAddress(host)))) {
    throw new SignedError("INVALID_REQUEST", "Webhook URL must be a public address", [{ code: "INVALID_REQUEST", field: "webhook_url", message: "Private address" }]);
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

/**
 * HTTP agent that checks the resolved IP at connect time. This blocks DNS rebinding:
 * the address that is checked is the address that is used.
 */
function safeAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, cb) {
        lookup(hostname, { ...options, all: false }, (err, address, family) => {
          if (err) return cb(err, address, family);
          if (!allowPrivate && isPrivateAddress(address as string)) {
            return cb(new Error(`Webhook target ${hostname} resolves to a private address`), address, family);
          }
          cb(null, address, family);
        });
      },
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
}

let agent: Agent | null = null;
let agentPrivate = false;

/**
 * Record a webhook event and queue delivery to the document URL (or the account default).
 * Runs inside the caller's transaction so events are never lost or duplicated.
 */
export async function emitWebhook(
  ctx: Ctx,
  trx: Transaction<Database> | Kysely<Database>,
  doc: { id: string; status: string; webhook_url: string | null; metadata: string },
  type: WebhookEventType,
  data: Record<string, unknown> = {},
): Promise<string | null> {
  const account = await getAccount(ctx, trx);
  const url = doc.webhook_url ?? account.config.webhook_url;
  if (!url) return null;
  const eventId = newId("evt");
  const body = JSON.stringify({
    id: eventId,
    type,
    created_at: now(),
    data: { document_id: doc.id, status: doc.status, metadata: JSON.parse(doc.metadata), ...data },
  });
  const deliveryId = newId("whd");
  await trx
    .insertInto("webhook_deliveries")
    .values({
      id: deliveryId,
      event_id: eventId,
      event_type: type,
      document_id: doc.id,
      url,
      body,
      status: "pending",
      attempts: 0,
      last_status_code: null,
      last_error: null,
      created_at: now(),
      delivered_at: null,
    })
    .execute();
  await enqueueJob(trx, "webhook", { delivery_id: deliveryId }, { maxAttempts: 10, dedupeKey: `webhook:${deliveryId}` });
  return eventId;
}

/** Signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export async function deliverWebhook(ctx: Ctx, deliveryId: string): Promise<void> {
  const d = await ctx.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", deliveryId).executeTakeFirst();
  if (!d || !deliveryMachine.can(d.status, "deliver")) return;
  const account = await getAccount(ctx);
  const allowPrivate = ctx.config.allowInsecureWebhooks;
  if (!agent || agentPrivate !== allowPrivate) {
    agent = safeAgent(allowPrivate);
    agentPrivate = allowPrivate;
  }

  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    assertWebhookUrlShape(ctx, d.url);
    const res = await fetch(d.url, {
      method: "POST",
      body: d.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "Signed.md-Webhook/1",
        "signed-md-event-id": d.event_id,
        "signed-md-event-type": d.event_type,
        "signed-md-signature": signWebhook(account.config.webhook_secret, d.body),
      },
      dispatcher: agent,
    });
    statusCode = res.status;
    await res.body?.cancel();
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).cause ? `${(err as Error).message}: ${String(((err as Error).cause as Error).message ?? (err as Error).cause)}` : (err as Error).message;
  }

  // Only a pending delivery moves on: a late attempt never undoes a delivery that already succeeded.
  await ctx.db
    .updateTable("webhook_deliveries")
    .set((eb) => ({
      attempts: eb("attempts", "+", 1),
      last_status_code: statusCode,
      last_error: error,
      status: deliveryMachine.next(d.status, error ? "retry" : "deliver"),
      delivered_at: error ? null : now(),
    }))
    .where("id", "=", d.id)
    .where("status", "=", "pending")
    .execute();
  if (error) throw new Error(`Webhook delivery failed: ${error}`);
}

/** The job gave up retrying. A delivery that succeeded in the meantime stays delivered. */
export async function markWebhookFailed(ctx: Ctx, deliveryId: string): Promise<void> {
  await ctx.db
    .updateTable("webhook_deliveries")
    .set({ status: deliveryMachine.next("pending", "give_up") })
    .where("id", "=", deliveryId)
    .where("status", "in", deliveryMachine.sources("give_up"))
    .execute();
}

export async function listDeliveries(ctx: Ctx, limit = 50) {
  return ctx.db
    .selectFrom("webhook_deliveries")
    .select(["id", "event_id", "event_type", "document_id", "url", "status", "attempts", "last_status_code", "last_error", "created_at", "delivered_at"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
