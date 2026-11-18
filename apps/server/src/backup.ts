import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { backupSqlite } from "@signed-md/db";
import { sql } from "kysely";
import type { Config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { log } from "./log.ts";
import { S3Bucket } from "./storage.ts";

/**
 * SQLite backups to S3, on when BACKUP_DB=true and S3 is configured.
 *
 * - Every minute, if the database changed since the last snapshot, a gzipped copy is uploaded to
 *   `<prefix>db/<timestamp>.db.gz`, and `<prefix>db/latest.json` points to it.
 * - One snapshot at startup and one at shutdown (so a stopped container is always backed up).
 * - The keys folder (manifest signing key, server secret, PDF seal) goes to `<prefix>keys/keys.json`
 *   whenever it changes.
 * - Old snapshots are never deleted by the app. Expire them with a bucket lifecycle rule.
 */

interface Latest {
  key: string;
  created_at: string;
  bytes: number;
}

interface KeysBundle {
  files: Record<string, string>;
}

/** Where database backups would go, or why they are off. */
export function backupPlan(config: Config): { on: true; bucket: S3Bucket; dbPath: string } | { on: false; reason: string; warn: boolean } {
  if (!config.backupDb) return { on: false, reason: "BACKUP_DB is not set", warn: false };
  if (!config.s3) return { on: false, reason: "BACKUP_DB is set, but S3 is not configured (S3_BUCKET)", warn: true };
  if (!config.databaseUrl.startsWith("sqlite:")) return { on: false, reason: "BACKUP_DB only backs up SQLite. Back up PostgreSQL with its own tools", warn: true };
  const dbPath = config.databaseUrl.replace(/^sqlite:(\/\/)?/, "");
  if (dbPath === ":memory:") return { on: false, reason: "the database is in memory", warn: true };
  return { on: true, bucket: new S3Bucket(config.s3), dbPath };
}

/**
 * Before the database is opened: if the local database or keys are missing, fetch the latest
 * backup. This is how a workspace moves to a new server, or comes back after a disk failure.
 */
export async function restoreIfMissing(config: Config): Promise<void> {
  const plan = backupPlan(config);
  if (!plan.on) return;
  const keysDir = join(config.dataDir, "keys");

  const bundle = await plan.bucket.get("keys/keys.json");
  if (bundle) {
    const { files } = JSON.parse(bundle.toString("utf8")) as KeysBundle;
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const [name, b64] of Object.entries(files)) {
      if (name.includes("/") || name.startsWith(".")) continue;
      const path = join(keysDir, name);
      if (!existsSync(path)) {
        writeFileSync(path, Buffer.from(b64, "base64"), { mode: 0o600 });
        log.info("restored key file from backup", { file: name });
      }
    }
  }

  if (existsSync(plan.dbPath)) return;
  const latest = await plan.bucket.get("db/latest.json");
  if (!latest) return;
  const info = JSON.parse(latest.toString("utf8")) as Latest;
  const gz = await plan.bucket.get(info.key);
  if (!gz) throw new Error(`Database backup '${info.key}' is listed in db/latest.json but missing from the bucket`);
  mkdirSync(dirname(plan.dbPath), { recursive: true });
  writeFileSync(plan.dbPath, gunzipSync(gz));
  log.info("restored database from backup", { snapshot: info.key, created_at: info.created_at });
}

export interface DbBackup {
  /** Take a snapshot now if anything changed. */
  run(): Promise<void>;
  /** Stop the timer and take a last snapshot. */
  stop(): Promise<void>;
}

export function startDbBackup(ctx: Ctx, intervalMs = 60_000): DbBackup | null {
  const plan = backupPlan(ctx.config);
  if (!plan.on) {
    if (plan.warn) log.warn(`database backups: off (${plan.reason})`);
    else log.info(`database backups: off (${plan.reason})`);
    return null;
  }
  const { bucket, dbPath } = plan;
  const keysDir = join(ctx.config.dataDir, "keys");
  log.info("database backups: on", { every: `${Math.round(intervalMs / 1000)}s when changed`, to: `${bucket.url}db/` });

  // SQLite uses one connection, so total_changes() counts every write the app made.
  let lastChanges = -1;
  let lastKeys = "";
  let running: Promise<void> | null = null;

  const changes = async (): Promise<number> => {
    const r = await sql<{ n: number }>`select total_changes() as n`.execute(ctx.db);
    return Number(r.rows[0]?.n ?? 0);
  };

  const snapshot = async (): Promise<void> => {
    const keys = readKeys(keysDir);
    if (keys.hash !== lastKeys) {
      await bucket.put("keys/keys.json", JSON.stringify(keys.bundle), "application/json");
      lastKeys = keys.hash;
    }
    const n = await changes();
    if (n === lastChanges) return;
    const dir = mkdtempSync(join(tmpdir(), "smd-backup-"));
    try {
      const file = join(dir, "signed.db");
      await backupSqlite(ctx.config.databaseUrl, file);
      const gz = gzipSync(readFileSync(file));
      const created = new Date().toISOString();
      const key = `db/${created.replace(/[:.]/g, "-")}.db.gz`;
      await bucket.put(key, gz, "application/gzip");
      await bucket.put("db/latest.json", JSON.stringify({ key, created_at: created, bytes: gz.length } satisfies Latest), "application/json");
      lastChanges = n;
      log.debug("database backed up", { key, bytes: gz.length });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const run = (): Promise<void> => {
    running ??= snapshot()
      .catch((e: Error) => log.error("database backup failed", { error: e.message }))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();

  return {
    run,
    async stop() {
      clearInterval(timer);
      await running;
      await run();
    },
  };
}

function readKeys(dir: string): { bundle: KeysBundle; hash: string } {
  const files: Record<string, string> = {};
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (name.startsWith(".") || !statSync(path).isFile()) continue;
      files[name] = readFileSync(path).toString("base64");
    }
  }
  const bundle = { files };
  return { bundle, hash: createHash("sha256").update(JSON.stringify(bundle)).digest("hex") };
}
