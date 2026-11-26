import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { migrationProvider } from "./migrations.ts";
import type { Database } from "./schema.ts";

export type Dialect = "sqlite" | "postgres";

export interface Db {
  db: Kysely<Database>;
  dialect: Dialect;
  close(): Promise<void>;
}

/**
 * Open a database from a URL. The scheme selects the dialect:
 *   sqlite:///data/signed.db   (absolute path)
 *   sqlite://./signed.db       (relative path)
 *   sqlite::memory:
 *   postgres://user:pass@host:5432/db
 */
export function openDatabase(url: string): Db {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    // The Postgres driver loads on the first query, so SQLite installs start faster.
    const pool = async () => new (await import("pg")).default.Pool({ connectionString: url, max: 10 });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { db, dialect: "postgres", close: () => db.destroy() };
  }

  if (url.startsWith("sqlite:")) {
    const rest = url.slice("sqlite:".length);
    const path = rest === ":memory:" ? ":memory:" : rest.replace(/^\/\//, "");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const sqlite = new SQLite(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("synchronous = NORMAL");
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    return { db, dialect: "sqlite", close: () => db.destroy() };
  }

  throw new Error(`Unsupported DATABASE_URL '${url}'. Use sqlite:///path/to/file.db or postgres://...`);
}

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** Cheap connectivity check for the health endpoint. */
export async function ping(db: Kysely<Database>): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

/** Online SQLite backup to a file. Safe while the server is running. */
export async function backupSqlite(url: string, destFile: string): Promise<void> {
  const path = url.replace(/^sqlite:(\/\/)?/, "");
  if (path === ":memory:") throw new Error("Cannot back up an in-memory database");
  const db = new SQLite(path, { readonly: true });
  try {
    await db.backup(destFile);
  } finally {
    db.close();
  }
}
