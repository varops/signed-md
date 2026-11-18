import { migrateToLatest, openDatabase } from "@signed-md/db";
import { type Config, loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { Keys } from "./keys.ts";
import { setLogLevel } from "./log.ts";
import { Mailer } from "./services/mail.ts";
import { restoreIfMissing } from "./backup.ts";
import { setAccountActive } from "./services/permissions.ts";
import { FsStorage, S3Bucket, S3Storage } from "./storage.ts";

/** Open the database, run migrations, load keys. Shared by the server, CLI, and tests. */
export async function createContext(config: Config = loadConfig()): Promise<Ctx & { close(): Promise<void> }> {
  setLogLevel(config.logLevel);
  setAccountActive(config.active);
  // A new server, or a lost disk: bring back the database and keys before opening them.
  await restoreIfMissing(config);
  const { db, dialect, close } = openDatabase(config.databaseUrl);
  await migrateToLatest(db);
  return {
    config,
    db,
    dialect,
    keys: new Keys(config.dataDir),
    storage: config.s3 ? new S3Storage(new S3Bucket(config.s3)) : new FsStorage(config.storagePath),
    mailer: new Mailer(config.dataDir, config.smtp),
    close,
  };
}
