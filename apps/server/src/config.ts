import { join, resolve } from "node:path";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string;
  storagePath: string;
  /** SMTP from the environment. Settings saved in the UI take precedence. */
  smtp: SmtpConfig | null;
  typstBin: string;
  /** Development only: allow http:// and private-network webhook targets. */
  allowInsecureWebhooks: boolean;
  /** Run the background worker in this process. */
  worker: boolean;
  workerIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? "./.data");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT must be a valid port, got '${env.PORT}'`);

  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    const u = new URL(publicUrl);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
  } catch {
    throw new ConfigError(`PUBLIC_URL must be an http(s) URL, got '${publicUrl}'`);
  }

  let smtp: SmtpConfig | null = null;
  if (env.SMTP_HOST) {
    const smtpPort = Number(env.SMTP_PORT ?? 587);
    smtp = {
      host: env.SMTP_HOST,
      port: smtpPort,
      secure: bool(env.SMTP_SECURE, smtpPort === 465),
      from: env.SMTP_FROM ?? `Signed.md <no-reply@${new URL(publicUrl).hostname}>`,
    };
    if (env.SMTP_USER) smtp.user = env.SMTP_USER;
    if (env.SMTP_PASS) smtp.pass = env.SMTP_PASS;
  }

  const level = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  return {
    port,
    publicUrl,
    dataDir,
    databaseUrl: env.DATABASE_URL ?? `sqlite://${join(dataDir, "signed.db")}`,
    storagePath: resolve(env.STORAGE_PATH ?? join(dataDir, "files")),
    smtp,
    typstBin: env.TYPST_BIN ?? "typst",
    allowInsecureWebhooks: bool(env.ALLOW_INSECURE_WEBHOOKS),
    worker: bool(env.WORKER, true),
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
    logLevel: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
  };
}
