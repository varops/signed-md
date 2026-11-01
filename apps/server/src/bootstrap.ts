import { migrateToLatest, openDatabase } from "@signed-md/db";
import { type Config, loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { Keys } from "./keys.ts";
import { setLogLevel } from "./log.ts";
import { Mailer } from "./services/mail.ts";
import { Storage } from "./storage.ts";

/** Open the database, run migrations, load keys. Shared by the server, CLI, and tests. */
export async function createContext(config: Config = loadConfig()): Promise<Ctx & { close(): Promise<void> }> {
  setLogLevel(config.logLevel);
  const { db, dialect, close } = openDatabase(config.databaseUrl);
  await migrateToLatest(db);
  return {
    config,
    db,
    dialect,
    keys: new Keys(config.dataDir),
    storage: new Storage(config.storagePath),
    mailer: new Mailer(config.dataDir, config.smtp),
    close,
  };
}
