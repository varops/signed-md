import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import type { Actor } from "../src/context.ts";
import { setup } from "../src/services/accounts.ts";

export const TEMPLATE = `---
fields:
  $fee:
    label: Monthly fee
    minimum: "100.00"
  $notice_days:
    allowed_values: [30, 60, 90]
---

# Service agreement

This agreement is between **Automaze** and {{$client_name:text}}.

| Item | Amount |
|---|---|
| Monthly fee | {{$fee:currency(USD)}} |

Either party may end this agreement with {{$notice_days:number}} days' written notice.

Start date: {{client.start_date:date}}

Client signature: {{client.signature:signature}}

Provider signature: {{provider.signature:signature}}
`;

export async function testContext(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "signedmd-test-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    DATABASE_URL: env.DATABASE_URL ?? "sqlite::memory:",
    PUBLIC_URL: "http://localhost:3999",
    LOG_LEVEL: "warn",
    ALLOW_INSECURE_WEBHOOKS: "1",
    ...env,
  });
  const ctx = await createContext(config);
  const { accountId, userId } = await setup(ctx, { accountName: "Automaze", email: "admin@automaze.example", password: "correct horse battery" });
  const user: Actor & { kind: "user" } = { kind: "user", id: userId, accountId, label: "admin@automaze.example" };
  const api: Actor = { kind: "apikey", id: "key_test", accountId, label: "test key", via: "api" };
  return { ctx, user, api, dataDir };
}
