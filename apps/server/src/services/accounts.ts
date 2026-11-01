import { SignedError } from "@signed-md/core";
import { type Database, newId, now } from "@signed-md/db";
import type { Kysely } from "kysely";
import type { SmtpConfig } from "../config.ts";
import type { Ctx } from "../context.ts";
import { randomToken } from "../crypto.ts";
import { hashPassword } from "./auth.ts";

export type InlineDocumentsSetting = "allowed" | "needs_approval" | "disabled";

export interface AccountConfig {
  webhook_url: string | null;
  webhook_secret: string;
  inline_documents: InlineDocumentsSetting;
  default_expiry_days: number;
  timezone: string;
  locale: string;
  /** SMTP saved in the UI. Overrides SMTP_* environment variables. */
  smtp: SmtpConfig | null;
  /** Attach the completed ZIP to completion emails (the PDF is always attached). */
  attach_zip: boolean;
}

export interface Account {
  id: string;
  name: string;
  config: AccountConfig;
  created_at: string;
}

const DEFAULTS: Omit<AccountConfig, "webhook_secret"> = {
  webhook_url: null,
  inline_documents: "allowed",
  default_expiry_days: 14,
  timezone: "UTC",
  locale: "en-US",
  smtp: null,
  attach_zip: false,
};

export function newWebhookSecret(): string {
  return `whsec_${randomToken(24)}`;
}

export async function isSetUp(ctx: Ctx): Promise<boolean> {
  const row = await ctx.db.selectFrom("accounts").select("id").limit(1).executeTakeFirst();
  return row !== undefined;
}

/** First-run setup: one account and one administrator. */
export async function setup(
  ctx: Ctx,
  input: { accountName: string; email: string; password: string },
): Promise<{ accountId: string; userId: string }> {
  if (input.password.length < 10) throw new SignedError("INVALID_REQUEST", "Password must be at least 10 characters");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new SignedError("INVALID_REQUEST", "A valid email is required");
  const passwordHash = await hashPassword(input.password);
  return ctx.db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom("accounts").select("id").limit(1).executeTakeFirst();
    if (existing) throw new SignedError("PERMISSION_DENIED", "Signed.md is already set up");
    const accountId = newId("acct");
    const userId = newId("usr");
    const config: AccountConfig = { ...DEFAULTS, webhook_secret: newWebhookSecret() };
    await trx
      .insertInto("accounts")
      .values({ id: accountId, name: input.accountName.trim() || "My company", config: JSON.stringify(config), created_at: now() })
      .execute();
    await trx
      .insertInto("users")
      .values({
        id: userId,
        account_id: accountId,
        email: input.email.trim().toLowerCase(),
        password_hash: passwordHash,
        status: "active",
        created_at: now(),
      })
      .execute();
    return { accountId, userId };
  });
}

/** Pass `db` when inside a transaction, so the read uses the same connection. */
export async function getAccount(ctx: Ctx, db: Kysely<Database> = ctx.db): Promise<Account> {
  const row = await db.selectFrom("accounts").selectAll().limit(1).executeTakeFirst();
  if (!row) throw new SignedError("PERMISSION_DENIED", "Signed.md is not set up yet");
  const stored = JSON.parse(row.config) as Partial<AccountConfig>;
  return {
    id: row.id,
    name: row.name,
    config: { ...DEFAULTS, webhook_secret: "", ...stored } as AccountConfig,
    created_at: row.created_at,
  };
}

export async function updateAccount(
  ctx: Ctx,
  patch: { name?: string; config?: Partial<AccountConfig> },
): Promise<Account> {
  const acct = await getAccount(ctx);
  const config = { ...acct.config, ...patch.config };
  if (config.webhook_url) {
    const { assertWebhookUrlShape } = await import("./webhooks.ts");
    assertWebhookUrlShape(ctx, config.webhook_url);
  }
  if (!Number.isInteger(config.default_expiry_days) || config.default_expiry_days < 1 || config.default_expiry_days > 365) {
    throw new SignedError("INVALID_REQUEST", "Default expiry must be between 1 and 365 days");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  } catch {
    throw new SignedError("INVALID_REQUEST", `Unknown timezone '${config.timezone}'`);
  }
  await ctx.db
    .updateTable("accounts")
    .set({ name: patch.name?.trim() || acct.name, config: JSON.stringify(config) })
    .where("id", "=", acct.id)
    .execute();
  return getAccount(ctx);
}

/** Public view of the account for the API. Never includes secrets. */
export function accountView(a: Account) {
  return {
    id: a.id,
    name: a.name,
    settings: {
      webhook_url: a.config.webhook_url,
      inline_documents: a.config.inline_documents,
      default_expiry_days: a.config.default_expiry_days,
      timezone: a.config.timezone,
      locale: a.config.locale,
    },
    created_at: a.created_at,
  };
}
