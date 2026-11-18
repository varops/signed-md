import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { startDbBackup } from "./backup.ts";
import { createContext } from "./bootstrap.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { startWorker } from "./worker.ts";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const ctx = await createContext(config);
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
    log.info("Signed.md listening", { port: info.port, public_url: config.publicUrl, database: ctx.dialect, smtp: config.smtp ? config.smtp.host : "outbox", storage: ctx.storage.location });
  });
  // A disabled account sends nothing: no reminders, emails or webhooks.
  const worker = config.worker && config.active ? startWorker(ctx) : null;
  const backup = startDbBackup(ctx);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    server.close();
    await worker?.stop();
    // Last snapshot after the worker's final writes, so a stopped container is fully backed up.
    await backup?.stop();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("fatal", { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
