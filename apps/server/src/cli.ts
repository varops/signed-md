/**
 * Admin commands for operators.
 *
 *   node apps/server/src/cli.ts setup --account "Acme" --email you@acme.com --password '...'
 *   node apps/server/src/cli.ts api-key --label "Sales agent"
 *   node apps/server/src/cli.ts backup ./backups/2026-11-01
 *
 * Uses the same environment variables as the server (DATA_DIR, DATABASE_URL, ...).
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backupSqlite } from "@signed-md/db";
import { createContext } from "./bootstrap.ts";
import { getAccount, isSetUp, setup } from "./services/accounts.ts";
import { createApiKey } from "./services/auth.ts";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`Commands:
  setup --account <name> --email <email> --password <password>   Create the administrator (fresh install only)
  api-key [--label <label>]                                       Create an API key and print it once
  backup <directory>                                              Copy the database, signing keys, and files`);
    return 0;
  }
  const ctx = await createContext();
  try {
    switch (cmd) {
      case "setup": {
        const account = arg(args, "account");
        const email = arg(args, "email");
        const password = arg(args, "password") ?? process.env.ADMIN_PASSWORD;
        if (!account || !email || !password) throw new Error("setup needs --account, --email and --password (or ADMIN_PASSWORD)");
        if (await isSetUp(ctx)) throw new Error("Already set up");
        await setup(ctx, { accountName: account, email, password });
        console.log(`Created account "${account}" with administrator ${email}.`);
        return 0;
      }
      case "api-key": {
        const user = await ctx.db.selectFrom("users").select(["id", "account_id", "email"]).where("status", "=", "active").executeTakeFirst();
        if (!user) throw new Error("Run setup first");
        const { key } = await createApiKey(ctx, { kind: "user", id: user.id, accountId: user.account_id, label: user.email }, arg(args, "label") ?? "CLI");
        console.log(key);
        return 0;
      }
      case "backup": {
        const dest = args[0];
        if (!dest) throw new Error("backup needs a destination directory");
        const out = resolve(dest);
        if (existsSync(join(out, "keys"))) throw new Error(`${out} already contains a backup`);
        mkdirSync(out, { recursive: true });
        if (ctx.dialect === "sqlite") {
          await backupSqlite(ctx.config.databaseUrl, join(out, "signed.db"));
        } else {
          console.log("PostgreSQL: back up the database with pg_dump. Copying keys and files only.");
        }
        cpSync(join(ctx.config.dataDir, "keys"), join(out, "keys"), { recursive: true });
        if (existsSync(ctx.config.storagePath)) cpSync(ctx.config.storagePath, join(out, "files"), { recursive: true });
        const account = await getAccount(ctx).catch(() => null);
        writeFileSync(join(out, "backup.json"), JSON.stringify({ created_at: new Date().toISOString(), account: account?.name ?? null, database: ctx.dialect, key_id: ctx.keys.info.kid }, null, 2));
        console.log(`Backup written to ${out}`);
        return 0;
      }
      default:
        throw new Error(`Unknown command '${cmd}'. Run with --help.`);
    }
  } finally {
    await ctx.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
