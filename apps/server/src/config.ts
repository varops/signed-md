import { join, resolve } from "node:path";
import { DEFAULT_HOSTED_APP_URL } from "./hosted.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface S3Config {
  /** Custom endpoint for S3-compatible services. Empty means AWS. */
  endpoint: string | null;
  bucket: string;
  region: string;
  /** Key prefix, empty or ending in "/". */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string;
  storagePath: string;
  /** S3 storage for files (and database backups). Null stores files on disk. */
  s3: S3Config | null;
  /** Back up the SQLite database and keys to S3. Needs `s3` and SQLite. */
  backupDb: boolean;
  /**
   * Hosted-service controls. Not documented on purpose.
   * BRANDING=false removes the "Powered by Signed.md" links from emails and signing pages.
   * ACTIVE=false disables the account: no logins, API, MCP or signing links, and no worker.
   * HOSTED=true needs SMTP_HOST, and hides the signing key settings and the Outbox.
   * MONTHLY_LIMIT and TOTAL_LIMIT cap sent contracts (-1, the default, means no limit).
   * REVIEW_SENDS holds the account's first N sent documents for review (0, the default, is off),
   * and REVIEW_NOTIFY_URL is told about each one (see services/review.ts).
   */
  branding: boolean;
  active: boolean;
  /** Domain for the login cookie. Null means the current host only. */
  cookieDomain: string | null;
  /** Key that signs the login cookie. Null derives one from keys/server-secret. */
  cookieHashKey: string | null;
  /**
   * "Continue with Google / Microsoft" links. Each points at a service that signs the person in,
   * writes the login cookie (same format and COOKIE_HASH_KEY) and redirects to `?next=`.
   * Hosted defaults to app.signed.md/oauth/google and /microsoft.
   */
  oauth: { google: string | null; microsoft: string | null };
  /** Email and password login. Off, people sign in only through the OAUTH_*_URL buttons. */
  allowEmailLogin: boolean;
  /** Our hosted service: needs SMTP, and hides the signing key settings and the Outbox. */
  hosted: boolean;
  /** The hosted app (HOSTED_APP_URL, hidden): account, billing and sign-in links. */
  hostedAppUrl: string;
  /** Plan limits on sent contracts, per calendar month (UTC) and in total. -1 means no limit. */
  monthlyLimit: number;
  totalLimit: number;
  /** Hold the first N sent documents until an operator releases them. 0 is off. */
  reviewSends: number;
  /** POSTed {"document_id"} when a document is held. Null tells nobody. */
  reviewNotifyUrl: string | null;
  /** SMTP from the environment. It can't be set in the UI. Null writes emails to the outbox. */
  smtp: SmtpConfig | null;
  typstBin: string;
  /** Development only: allow http:// and private-network webhook targets. */
  allowInsecureWebhooks: boolean;
  /** Run the background worker in this process. */
  worker: boolean;
  workerIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Where users can get this installation's source code (AGPL-3.0 section 13). */
  sourceUrl: string;
  /** Avatar service base URL: unavatar.io, or a CDN pull zone in front of it. Used only when avatars are on. */
  /** Where avatars come from. unavatar looks people up in many places; Gravatar only has people with an account. */
  avatarProvider: "unavatar" | "gravatar";
  /** unavatar publishable key (pk_…), added to avatar links as ?token=. Never a secret key: links are public. */
  unavatarToken: string | null;
  /** Base URL for avatar links: https://<UNAVATAR_DOMAIN> or https://<GRAVATAR_DOMAIN>/avatar. Either can be a CDN pull zone. */
  avatarBaseUrl: string;
  /** RFC 3161 timestamp authority. Only a hash is sent. Null disables trusted timestamps. */
  tsaUrl: string | null;
}

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export class ConfigError extends Error {}

function reviewSends(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`REVIEW_SENDS must be a whole number, got '${v}'`);
  return n;
}

function reviewNotifyUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^https?:\/\/[^/\s]+/.test(v)) throw new ConfigError(`REVIEW_NOTIFY_URL must be an http(s) URL, got '${v}'`);
  return v;
}

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

  const avatarProvider = (env.AVATAR_PROVIDER ?? "unavatar").trim().toLowerCase();
  if (avatarProvider !== "unavatar" && avatarProvider !== "gravatar") throw new ConfigError(`AVATAR_PROVIDER must be unavatar or gravatar, got '${avatarProvider}'`);
  // A domain (unavatar.io, avatars.example.com), or a full URL for local testing.
  const avatarDomain = (name: string, def: string): string => {
    const raw = (env[name] ?? "").trim().replace(/\/+$/, "") || def;
    const url = raw.includes("://") ? raw : `https://${raw}`;
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(url) && !/^http:\/\/localhost(:\d+)?(\/[^\s]*)?$/.test(url)) {
      throw new ConfigError(`${name} must be a domain like ${def}, got '${raw}'`);
    }
    return url;
  };
  const unavatarToken = (env.UNAVATAR_TOKEN ?? "").trim() || null;
  if (unavatarToken?.startsWith("sk_")) {
    throw new ConfigError("UNAVATAR_TOKEN must be a publishable key (pk_…). Avatar links are public, so a secret key (sk_…) would leak");
  }
  const avatarBaseUrl = avatarProvider === "gravatar" ? `${avatarDomain("GRAVATAR_DOMAIN", "gravatar.com")}/avatar` : avatarDomain("UNAVATAR_DOMAIN", "unavatar.io");

  const tsaRaw = (env.TSA_URL ?? "http://timestamp.digicert.com").trim();
  const tsa = tsaRaw === "" || tsaRaw.toLowerCase() === "off" ? null : tsaRaw;
  if (tsa && !/^https?:\/\/[^/\s]+/.test(tsa)) throw new ConfigError(`TSA_URL must be an http(s) URL or "off", got '${tsaRaw}'`);

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

  let s3: S3Config | null = null;
  if (env.S3_BUCKET) {
    const endpoint = (env.S3_ENDPOINT ?? "").trim().replace(/\/+$/, "");
    if (endpoint && !/^https?:\/\/[^/\s]+$/.test(endpoint)) throw new ConfigError(`S3_ENDPOINT must be an http(s) URL with no path, got '${endpoint}'`);
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) throw new ConfigError("S3_BUCKET is set, so S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
    const prefix = (env.S3_PREFIX ?? "").trim().replace(/^\/+/, "").replace(/\/*$/, "");
    s3 = {
      endpoint: endpoint || null,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || "us-east-1",
      prefix: prefix ? `${prefix}/` : "",
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    };
  }

  const cookieDomain = (env.COOKIE_DOMAIN ?? "").trim() || null;
  if (cookieDomain) {
    const host = new URL(publicUrl).hostname;
    const bare = cookieDomain.replace(/^\./, "");
    if (!/^[a-z0-9.-]+$/i.test(bare) || (host !== bare && !host.endsWith(`.${bare}`))) {
      throw new ConfigError(`COOKIE_DOMAIN must be PUBLIC_URL's host or a parent domain of it, got '${cookieDomain}'`);
    }
  }
  const cookieHashKey = (env.COOKIE_HASH_KEY ?? "").trim() || null;
  if (cookieHashKey && cookieHashKey.length < 32) throw new ConfigError("COOKIE_HASH_KEY must be at least 32 characters");

  const hosted = bool(env.HOSTED);
  if (hosted && !smtp) throw new ConfigError("HOSTED=true needs SMTP_HOST");

  const hostedAppUrl = (env.HOSTED_APP_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_HOSTED_APP_URL;
  if (!/^https?:\/\/[^/\s]+$/.test(hostedAppUrl)) throw new ConfigError(`HOSTED_APP_URL must be an http(s) origin, got '${hostedAppUrl}'`);
  const oauthLink = (name: string, hostedDefault: string): string | null => {
    const raw = (env[name] ?? "").trim();
    if (!raw) return hosted ? hostedDefault : null;
    if (!/^https?:\/\/[^/\s]+/.test(raw)) throw new ConfigError(`${name} must be an http(s) URL, got '${raw}'`);
    return raw;
  };
  const oauth = {
    google: oauthLink("OAUTH_GOOGLE_URL", `${hostedAppUrl}/oauth/google`),
    microsoft: oauthLink("OAUTH_MICROSOFT_URL", `${hostedAppUrl}/oauth/microsoft`),
  };

  const allowEmailLogin = bool(env.ALLOW_EMAIL_LOGIN, true);
  if (!allowEmailLogin && !oauth.google && !oauth.microsoft) {
    throw new ConfigError("ALLOW_EMAIL_LOGIN=false needs OAUTH_GOOGLE_URL or OAUTH_MICROSOFT_URL, or nobody can log in");
  }

  const limit = (name: string): number => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return -1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < -1) throw new ConfigError(`${name} must be a whole number, or -1 for no limit, got '${raw}'`);
    return n;
  };

  const level = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  return {
    port,
    publicUrl,
    dataDir,
    databaseUrl: env.DATABASE_URL ?? `sqlite://${join(dataDir, "signed.db")}`,
    storagePath: resolve(env.STORAGE_PATH ?? join(dataDir, "files")),
    s3,
    backupDb: bool(env.BACKUP_DB),
    branding: bool(env.BRANDING, true),
    active: bool(env.ACTIVE, true),
    hosted,
    hostedAppUrl,
    cookieDomain,
    cookieHashKey,
    oauth,
    allowEmailLogin,
    reviewSends: reviewSends(env.REVIEW_SENDS),
    reviewNotifyUrl: reviewNotifyUrl(env.REVIEW_NOTIFY_URL),
    monthlyLimit: limit("MONTHLY_LIMIT"),
    totalLimit: limit("TOTAL_LIMIT"),
    smtp,
    typstBin: env.TYPST_BIN ?? "typst",
    allowInsecureWebhooks: bool(env.ALLOW_INSECURE_WEBHOOKS),
    worker: bool(env.WORKER, true),
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
    logLevel: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
    sourceUrl: env.SOURCE_URL ?? "https://github.com/varops/signed-md",
    avatarProvider,
    avatarBaseUrl,
    unavatarToken,
    tsaUrl: tsa,
  };
}
