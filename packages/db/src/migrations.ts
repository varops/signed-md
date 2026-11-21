import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

/**
 * Migrations use only portable schema-builder features so they run on both SQLite and PostgreSQL.
 * Never edit a released migration. Add a new one.
 */
const m001: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("accounts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("config", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("users")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull().references("accounts.id"))
      .addColumn("email", "text", (c) => c.notNull().unique())
      .addColumn("password_hash", "text")
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("api_keys")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull().references("accounts.id"))
      .addColumn("user_id", "text", (c) => c.references("users.id"))
      .addColumn("key_hash", "text", (c) => c.notNull().unique())
      .addColumn("prefix", "text", (c) => c.notNull())
      .addColumn("label", "text", (c) => c.notNull())
      .addColumn("scope", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("last_used_at", "text")
      .addColumn("revoked_at", "text")
      .execute();

    await db.schema
      .createTable("templates")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull().references("accounts.id"))
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("description", "text", (c) => c.notNull())
      .addColumn("current_version", "integer", (c) => c.notNull())
      .addColumn("created_via", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("archived_at", "text")
      .execute();

    await db.schema
      .createTable("template_versions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("template_id", "text", (c) => c.notNull().references("templates.id"))
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("field_schema", "text", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("approval_status", "text", (c) => c.notNull())
      .addColumn("approved_by", "text")
      .addColumn("approved_at", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addUniqueConstraint("template_versions_template_version", ["template_id", "version"])
      .execute();

    await db.schema
      .createTable("documents")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull().references("accounts.id"))
      .addColumn("template_version_id", "text", (c) => c.references("template_versions.id"))
      .addColumn("source_kind", "text", (c) => c.notNull())
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("values_json", "text", (c) => c.notNull())
      .addColumn("content", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("timezone", "text", (c) => c.notNull())
      .addColumn("locale", "text", (c) => c.notNull())
      .addColumn("expires_in_days", "integer", (c) => c.notNull())
      .addColumn("metadata", "text", (c) => c.notNull())
      .addColumn("webhook_url", "text")
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("approved_revision", "text")
      .addColumn("approved_by", "text")
      .addColumn("inline_approved_by", "text")
      .addColumn("inline_approved_at", "text")
      .addColumn("inline_approved_revision", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addColumn("sent_at", "text")
      .addColumn("expires_at", "text")
      .addColumn("completed_at", "text")
      .addColumn("finalized_at", "text")
      .addColumn("revoked_at", "text")
      .addColumn("revoke_reason", "text")
      .addColumn("archived_at", "text")
      .execute();
    await db.schema.createIndex("documents_account_created").on("documents").columns(["account_id", "created_at"]).execute();
    await db.schema.createIndex("documents_status_expires").on("documents").columns(["status", "expires_at"]).execute();

    await db.schema
      .createTable("signers")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("document_id", "text", (c) => c.notNull().references("documents.id"))
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("signing_order", "integer", (c) => c.notNull())
      .addColumn("token_hash", "text", (c) => c.unique())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("decline_reason", "text")
      .addColumn("notified_at", "text")
      .addColumn("viewed_at", "text")
      .addColumn("consented_at", "text")
      .addColumn("signed_at", "text")
      .addColumn("declined_at", "text")
      .addUniqueConstraint("signers_document_key", ["document_id", "key"])
      .execute();

    await db.schema
      .createTable("fields")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("document_id", "text", (c) => c.notNull().references("documents.id"))
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("signer_key", "text")
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("definition", "text", (c) => c.notNull())
      .addColumn("value", "text")
      .addColumn("completed_at", "text")
      .addUniqueConstraint("fields_document_key", ["document_id", "key"])
      .execute();

    await db.schema
      .createTable("events")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("document_id", "text", (c) => c.notNull().references("documents.id"))
      .addColumn("seq", "integer", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("actor", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("data", "text", (c) => c.notNull())
      .addColumn("prev_hash", "text")
      .addColumn("hash", "text", (c) => c.notNull())
      .addUniqueConstraint("events_document_seq", ["document_id", "seq"])
      .execute();

    await db.schema
      .createTable("artifacts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("document_id", "text", (c) => c.notNull().references("documents.id"))
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("storage_path", "text", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("size", "integer", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addUniqueConstraint("artifacts_document_type", ["document_id", "type"])
      .execute();

    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull())
      .addColumn("max_attempts", "integer", (c) => c.notNull())
      .addColumn("run_at", "text", (c) => c.notNull())
      .addColumn("locked_until", "text")
      .addColumn("last_error", "text")
      .addColumn("dedupe_key", "text", (c) => c.unique())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("finished_at", "text")
      .execute();
    await db.schema.createIndex("jobs_status_run_at").on("jobs").columns(["status", "run_at"]).execute();

    await db.schema
      .createTable("idempotency_keys")
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("scope", "text", (c) => c.notNull())
      .addColumn("request_hash", "text", (c) => c.notNull())
      .addColumn("response", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("idempotency_keys_pk", ["key", "scope"])
      .execute();

    await db.schema
      .createTable("webhook_deliveries")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("event_id", "text", (c) => c.notNull())
      .addColumn("event_type", "text", (c) => c.notNull())
      .addColumn("document_id", "text")
      .addColumn("url", "text", (c) => c.notNull())
      .addColumn("body", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull())
      .addColumn("last_status_code", "integer")
      .addColumn("last_error", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("delivered_at", "text")
      .addUniqueConstraint("webhook_deliveries_event_url", ["event_id", "url"])
      .execute();
  },
};

const m002: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("documents").addColumn("signer_message", "text").execute();
  },
};

/** Teams: user roles and names, invitations, an audit log, document owners, and per-user API keys. */
const m003: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("users").addColumn("name", "text", (c) => c.notNull().defaultTo("")).execute();
    await db.schema.alterTable("users").addColumn("role", "text", (c) => c.notNull().defaultTo("member")).execute();
    await db.schema.alterTable("users").addColumn("invited_by", "text").execute();
    await db.schema.alterTable("users").addColumn("last_login_at", "text").execute();
    await db.schema.alterTable("users").addColumn("deactivated_at", "text").execute();
    // The single v1.0 administrator becomes the owner.
    await db.updateTable("users").set({ role: "owner" }).execute();

    await db.schema
      .createTable("invitations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull().references("accounts.id"))
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("invited_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("accepted_at", "text")
      .addColumn("revoked_at", "text")
      .execute();

    await db.schema
      .createTable("audit_events")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull())
      .addColumn("actor", "text", (c) => c.notNull())
      .addColumn("actor_label", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("data", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("audit_events_created").on("audit_events").columns(["account_id", "created_at"]).execute();

    await db.schema.alterTable("documents").addColumn("owner_user_id", "text").execute();
    const owner = await db.selectFrom("users").select("id").orderBy("created_at").limit(1).executeTakeFirst();
    if (owner) {
      await db.updateTable("documents").set({ owner_user_id: owner.id }).execute();
      await db.updateTable("api_keys").set({ user_id: owner.id }).where("user_id", "is", null).execute();
    }
  },
};

/** Contract font family per document. Existing documents keep the serif look they were sent with. */
const m004: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("documents").addColumn("font", "text", (c) => c.notNull().defaultTo("serif")).execute();
  },
};

/** Personal admin UI theme. */
const m005: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("users").addColumn("theme", "text", (c) => c.notNull().defaultTo("system")).execute();
  },
};

/** Contracts sent per calendar month (UTC), for plan limits. */
const m006: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("usage_counters")
      .addColumn("period", "text", (c) => c.primaryKey())
      .addColumn("sent", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
  },
};

/** Folders for organising templates and documents. One level; archived, never deleted. */
const m007: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("folders")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("account_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("archived_at", "text")
      .execute();
    await db.schema.createIndex("folders_kind").on("folders").columns(["account_id", "kind"]).execute();
    await db.schema.alterTable("templates").addColumn("folder_id", "text").execute();
    await db.schema.alterTable("documents").addColumn("folder_id", "text").execute();
    await db.schema.createIndex("documents_folder").on("documents").column("folder_id").execute();
  },
};

const m008: Migration = {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("password_resets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();
    await db.schema.createIndex("password_resets_user").on("password_resets").column("user_id").execute();
  },
};

/** Automatic reminders: a per-document switch, and each signer's link kept sealed so reminders reuse it. */
const m009: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("documents").addColumn("reminders", "integer", (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable("signers").addColumn("link_sealed", "text").execute();
    await db.schema.alterTable("signers").addColumn("reminders_sent", "integer", (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable("signers").addColumn("last_reminded_at", "text").execute();
  },
};

/** Reminders 24 hours and 1 hour before the deadline: which ones each signer has had. */
const m010: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable("signers").addColumn("deadline_reminders", "integer", (c) => c.notNull().defaultTo(0)).execute();
  },
};

export const migrations: Record<string, Migration> = {
  "001_initial": m001,
  "002_signer_message": m002,
  "003_teams": m003,
  "004_document_font": m004,
  "005_user_theme": m005,
  "006_usage_counters": m006,
  "007_folders": m007,
  "008_password_resets": m008,
  "009_reminders": m009,
  "010_deadline_reminders": m010,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
