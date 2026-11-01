/**
 * Start a seeded demo instance:  pnpm demo
 *
 * Creates (once) an account, an administrator, two approved templates, and an API key,
 * then starts the server with the worker. Emails go to the Outbox page.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createContext } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { isSetUp, setup } from "./services/accounts.ts";
import { createApiKey } from "./services/auth.ts";
import { createTemplate } from "./services/templates.ts";
import { startWorker } from "./worker.ts";

const root = resolve(import.meta.dirname, "..", "..", "..");
const EMAIL = "demo@signed.md";
const PASSWORD = "signed-md-demo";

const port = Number(process.env.PORT ?? 3000);
const config = loadConfig({
  DATA_DIR: join(root, ".data", "demo"),
  PUBLIC_URL: `http://localhost:${port}`,
  ALLOW_INSECURE_WEBHOOKS: "1",
  ...process.env,
});
const ctx = await createContext(config);

let apiKey: string | null = null;
if (!(await isSetUp(ctx))) {
  const { accountId, userId } = await setup(ctx, { accountName: "Automaze", email: EMAIL, password: PASSWORD });
  const user = { kind: "user" as const, id: userId, accountId, label: EMAIL };
  await createTemplate(ctx, user, {
    name: "Standard services agreement",
    description: "Monthly retainer, notice period, client signs first then we countersign",
    source: readFileSync(join(root, "examples", "templates", "services-agreement.md"), "utf8"),
    approve: true,
  });
  await createTemplate(ctx, user, {
    name: "Mutual NDA",
    description: "Two-way confidentiality agreement",
    source: readFileSync(join(root, "examples", "templates", "mutual-nda.md"), "utf8"),
    approve: true,
  });
  apiKey = (await createApiKey(ctx, user, "Demo agent")).key;
}

serve({ fetch: createApp(ctx).fetch, port });
startWorker(ctx);

console.log(`
  Signed.md demo running at ${config.publicUrl}

  Log in:     ${EMAIL} / ${PASSWORD}
  Data:       ${config.dataDir}  (delete it to start over)
${apiKey ? `  API key:    ${apiKey}   (shown once)

  Connect Claude Code:
    claude mcp add --transport http signed-md ${config.publicUrl}/mcp --header "Authorization: Bearer ${apiKey}"
` : "  API key:    create one in Settings → API keys\n"}
  Then ask:   "Send Acme our standard agreement for $1,000/month with a 30-day termination clause.
               Jane Doe (jane@acme.example) signs for Acme. Show me before sending."

  No SMTP is set, so signing emails appear on the Outbox page.
`);
