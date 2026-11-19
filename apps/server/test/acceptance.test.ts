/**
 * The defining end-to-end test for Signed.md v1.0 (docs/integrations.md §19).
 * Drives the real server: web UI in a browser, an agent over MCP, signers in the browser,
 * webhooks to a local receiver, and offline verification of the package.
 *
 * Set SCREENSHOTS=1 to save screenshots to docs/screenshots.
 * Set E2E_BASE_URL to run against an already running, freshly installed server (for example the
 * Docker image started with ALLOW_INSECURE_WEBHOOKS=1 on the host network).
 */
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { openDatabase } from "@signed-md/db";
import { sql } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createContext } from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { startWorker, type WorkerHandle } from "../src/worker.ts";
import { trustedKeysFrom, verifyPackage } from "signed-md";
import { startFakeTsa } from "./fakeTsa.ts";

const require = createRequire(import.meta.url);
// Playwright is not a project dependency. Use the one on this machine, or set PLAYWRIGHT_PATH.
function loadPlaywright(): typeof import("playwright") | null {
  for (const id of [process.env.PLAYWRIGHT_PATH, "playwright"]) {
    if (!id) continue;
    try {
      return require(id) as typeof import("playwright");
    } catch {}
  }
  return null;
}
const playwright = loadPlaywright();

const SHOTS = process.env.SCREENSHOTS === "1" ? join(import.meta.dirname, "..", "..", "..", "docs", "screenshots") : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TEMPLATE = `---
fields:
  $fee:
    label: Monthly fee
    minimum: "500.00"
  $notice_days:
    label: Notice period (days)
    allowed_values: [30, 60, 90]
---

# Software development services agreement

This agreement is made between **Automaze Ltd** ("Provider") and {{$client_name:text}} ("Client").

## 1. Services

Provider will deliver software development services as agreed in writing between the parties.

## 2. Fees

| Item | Amount |
|---|---|
| Monthly retainer | {{$fee:currency(USD)}} |

Invoices are due within 14 days.

## 3. Termination

Either party may end this agreement with {{$notice_days:number}} days' written notice.

## 4. Signatures

**Client**

Name: {{client.full_name:text}}

Signature: {{client.signature:signature}}

Date: {{client.date:date}}

**Provider**

Signature: {{provider.signature:signature}}
`;

interface Hook {
  headers: Record<string, string>;
  body: string;
}

describe.skipIf(!playwright)("v1.0 acceptance: agent-driven signing, end to end", () => {
  let server: ReturnType<typeof serve>;
  let worker: WorkerHandle;
  let hookServer: Server;
  let avatarServer: Server;
  let tsa: Awaited<ReturnType<typeof startFakeTsa>>;
  const avatarRequests: string[] = [];
  let base = "";
  const hooks: Hook[] = [];
  let close: () => Promise<void>;

  beforeAll(async () => {
    hookServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hooks.push({ headers: req.headers as Record<string, string>, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));

    // Stands in for a CDN pull zone in front of unavatar.io (UNAVATAR_DOMAIN).
    const avatarPng = readFileSync(join(import.meta.dirname, "fixtures", "avatar.png"));
    avatarServer = createServer((req, res) => {
      avatarRequests.push(decodeURIComponent(req.url ?? ""));
      res.writeHead(200, { "content-type": "image/png" }).end(avatarPng);
    });
    await new Promise<void>((r) => avatarServer.listen(0, "127.0.0.1", r));

    if (process.env.E2E_BASE_URL) {
      base = process.env.E2E_BASE_URL.replace(/\/$/, "");
      return;
    }
    // The acceptance test needs a fresh install. Reset a shared Postgres test database first.
    if (process.env.E2E_DATABASE_URL?.startsWith("postgres")) {
      const pg = openDatabase(process.env.E2E_DATABASE_URL);
      await sql`drop schema public cascade`.execute(pg.db);
      await sql`create schema public`.execute(pg.db);
      await pg.close();
    }
    tsa = await startFakeTsa();
    const port = 3200 + Math.floor(Math.random() * 500);
    base = `http://localhost:${port}`;
    const dataDir = mkdtempSync(join(tmpdir(), "signedmd-e2e-"));
    const ctx = await createContext(
      loadConfig({ DATA_DIR: dataDir, PORT: String(port), PUBLIC_URL: base, TSA_URL: tsa.url, UNAVATAR_DOMAIN: `http://localhost:${(avatarServer.address() as AddressInfo).port}`, LOG_LEVEL: "warn", ALLOW_INSECURE_WEBHOOKS: "1", WORKER_INTERVAL_MS: "100", ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}) }),
    );
    server = serve({ fetch: createApp(ctx).fetch, port });
    worker = startWorker(ctx);
    close = ctx.close;
  });

  afterAll(async () => {
    await worker?.stop();
    server?.close();
    hookServer?.close();
    avatarServer?.close();
    await tsa?.close();
    await close?.();
  });

  it("completes the MVP workflow", async () => {
    const browser = await playwright!.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const shot = async (name: string, p = page) => {
      if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
    };

    // 1–2. Fresh install: initial administrator setup.
    await page.goto(base);
    expect(page.url()).toContain("/setup");
    await shot("01-setup");
    await page.fill("input[name=account]", "Automaze");
    await page.fill("input[name=name]", "Ran Aroussi");
    await page.fill("input[name=email]", "ran@automaze.example");
    await page.fill("input[name=password]", "a very good password");
    await page.click("button:has-text('Create account')");
    await page.waitForURL(/\/documents/);

    // 4. Create and approve a Markdown template in the UI.
    await page.goto(`${base}/templates/new`);
    await page.fill("input[name=name]", "Standard services agreement");
    await page.fill("input[name=description]", "Monthly retainer with notice period");
    await page.fill("textarea[name=source]", TEMPLATE);
    await shot("02-template-editor");
    await page.click("button:has-text('Save and approve')");
    await page.waitForURL(/\/templates\/tpl_/);
    await shot("03-template");

    // Branding: a logo and a default message to signers.
    await page.goto(`${base}/settings/branding`);
    await page.setInputFiles("input[name=logo]", join(import.meta.dirname, "fixtures", "logo.png"));
    await page.click("button:has-text('Upload')");
    await page.waitForURL(/msg=logo/);
    await page.fill("#banner_color", "#1e3a8a");
    await page.check("input[name=avatars]");
    await page.click("form[action='/settings/branding/look'] button");
    await page.waitForURL(/msg=saved/);
    await page.fill("textarea[name=message]", "Hi, please review and sign at your convenience. Reply to this email with any questions.");
    await page.click("form[action='/settings/branding/message'] button");
    await page.waitForURL(/msg=saved/);
    await page.waitForTimeout(300);
    await shot("11-branding");

    // Create an API key for the agent.
    await page.goto(`${base}/agentic`);
    await page.fill("input[name=label]", "Sales agent");
    await page.click("button:has-text('Create API key')");
    const apiKey = (await page.locator(".note pre").textContent())!.trim();
    expect(apiKey).toMatch(/^smd_/);

    // Configure the webhook (REST).
    const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hooks`;
    const wh = await fetch(`${base}/v1/webhooks`, { method: "PUT", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url: hookUrl }) });
    const { secret } = (await wh.json()) as { secret: string };

    // 5. Connect an agent through MCP.
    const mcp = new Client({ name: "acceptance-agent", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["signed_list_templates", "signed_create_document", "signed_preview_document", "signed_send_document", "signed_get_artifacts"]));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await mcp.callTool({ name, arguments: args });
      return { ok: !r.isError, data: r.structuredContent as any };
    };

    // 6. "Prepare our standard service agreement for Acme Ltd at $1,000 per month with 30 days' notice."
    const list = await call("signed_list_templates", {});
    const template = list.data.data.find((t: any) => t.name === "Standard services agreement");
    expect(template.approved_version).toBe(1);
    const detail = await call("signed_get_template", { template_id: template.id });
    expect(detail.data.fields.map((f: any) => f.key)).toContain("$fee");

    // The agent tries a fee below the template minimum: the server refuses it.
    const low = await call("signed_create_document", {
      template_id: template.id,
      values: { client_name: "Acme Ltd", fee: "100.00", notice_days: 30 },
      signers: [
        { key: "client", name: "Jane Doe", email: "jane@acme.example", order: 1 },
        { key: "provider", name: "Ran Aroussi", email: "ran@automaze.example", order: 2 },
      ],
      metadata: { customer_id: "acme", source: "sales-agent" },
    });
    expect(low.ok).toBe(true);
    expect(low.data.validation.valid).toBe(false);
    expect(low.data.validation.errors[0]).toMatchObject({ code: "FIELD_INVALID", field: "$fee" });

    // It fixes the value as instructed and validates.
    const docId = low.data.id;
    const fixed = await call("signed_update_document", { document_id: docId, values: { fee: "1000.00" } });
    expect(fixed.data.validation.valid).toBe(true);
    const validation = await call("signed_validate_document", { document_id: docId });
    expect(validation.data.valid).toBe(true);

    // 7. Preview, then (simulated) human approval of that exact revision.
    const preview = await call("signed_preview_document", { document_id: docId });
    expect(preview.data.markdown).toContain("$1,000.00");
    expect(preview.data.signing_order.map((g: any) => g.signers.map((s: any) => s.key))).toEqual([["client"], ["provider"]]);
    await page.goto(`${base}/documents/${docId}`);
    await shot("04-draft-preview");

    // A stale revision is rejected.
    const stale = await call("signed_send_document", { document_id: docId, approved_revision: "rev_stale" });
    expect(stale.ok).toBe(false);
    expect(stale.data.error.code).toBe("REVISION_MISMATCH");

    // 8. Approve and send.
    const sent = await call("signed_send_document", {
      document_id: docId,
      approved_revision: preview.data.revision,
      approved_by: "Ran, in chat",
      message: "Hi Jane, here is the agreement we discussed on Friday.",
    });
    expect(sent.ok).toBe(true);
    expect(sent.data.status).toBe("sent");

    // 9. Sign through a browser. Signing links arrive by email (the outbox, as no SMTP is set).
    const linkFor = async (email: string) => {
      for (let i = 0; i < 50; i++) {
        await page.goto(`${base}/outbox`);
        // Match the recipient line only: the sender's address also appears in other people's emails.
        const mail = page.locator("details").filter({ has: page.locator("summary", { hasText: `→ ${email}` }) }).first();
        const text = await mail.locator("pre").textContent({ timeout: 500 }).catch(() => null);
        const m = text ? /\/s\/([A-Za-z0-9_-]{30,})/.exec(text) : null;
        if (m) return `${base}/s/${m[1]}`;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`No signing email for ${email}`);
    };

    // The signing email is HTML, branded with the logo, and carries the agent's message.
    const janeLink = await linkFor("jane@acme.example");
    await page.goto(`${base}/outbox`);
    const emailFrame = page.frameLocator("iframe.email-frame").first();
    await emailFrame.locator("text=Hi Jane, here is the agreement we discussed on Friday.").waitFor();
    expect(await emailFrame.locator("img[src^='data:image/png']").count()).toBe(2); // the account logo and the Signed.md footer logo, inline
    expect(await emailFrame.locator("a:has-text('REVIEW DOCUMENT')").count()).toBe(1);
    // Avatars: the sender in the banner, and each signer, via the avatar base URL.
    expect(await emailFrame.locator("img[alt='Jane Doe']").count()).toBeGreaterThan(0);
    expect(avatarRequests.some((u) => u.includes("jane@acme.example"))).toBe(true);
    await shot("12-signing-email");

    const signer = await browser.newPage({ viewport: { width: 420, height: 900 }, isMobile: true, hasTouch: true });
    await signer.goto(janeLink);
    // "Let's start": agree to sign electronically before the document opens.
    await shot("05-signing-intro", signer);
    await signer.check("input[name=consent]");
    await signer.click("button:has-text('Continue')");
    await signer.waitForSelector("#guide-next");
    await shot("06-signing-document", signer);
    // Guided: Start jumps to the first required field.
    await signer.click("#guide-next");
    await signer.fill("input[name='f:client.full_name']", "Jane Doe");
    await signer.fill("input[name='f:client.date']", "2026-11-02");
    // Sign inline: the Sign tag opens "Adopt your signature". Draw it.
    await signer.click("[data-smd-field='client.signature'] .smd-sign-tag");
    await signer.click("#adopt .sig-modes button[data-mode=drawn]");
    const canvas = signer.locator("#adopt-pad");
    const box = (await canvas.boundingBox())!;
    await signer.mouse.move(box.x + 30, box.y + 100);
    await signer.mouse.down();
    for (let i = 0; i <= 20; i++) await signer.mouse.move(box.x + 30 + i * 14, box.y + 100 - Math.sin(i / 2) * 40, { steps: 2 });
    await signer.mouse.up();
    await shot("07-adopt-signature", signer);
    await signer.click("#adopt-ok");
    await signer.waitForSelector("[data-smd-field='client.signature'].smd-done img");
    await shot("08-signing-filled", signer);
    await signer.click("#guide-next"); // now reads "Finish"
    await signer.waitForSelector("h1:has-text('done')");

    // The provider countersigns (order 2) with a typed signature, after the client.
    const provider = await browser.newPage();
    await provider.goto(await linkFor("ran@automaze.example"));
    await provider.check("input[name=consent]");
    await provider.click("button:has-text('Continue')");
    await provider.click("[data-smd-field='provider.signature'] .smd-sign-tag");
    expect(await provider.inputValue("#adopt-text")).toBe("Ran Aroussi"); // prefilled from the signer's name
    await provider.click("#adopt-ok");
    await provider.click("#guide-next");
    await provider.waitForSelector("h1:has-text('done')");

    // 10. Receive webhooks: awaiting_last_signer, signed, finalized. All signed with HMAC.
    for (let i = 0; i < 100 && !hooks.some((h) => JSON.parse(h.body).type === "document.finalized"); i++) await new Promise((r) => setTimeout(r, 200));
    const types = hooks.map((h) => JSON.parse(h.body).type);
    expect(types).toEqual(["document.awaiting_last_signer", "document.signed", "document.finalized"]);
    for (const h of hooks) {
      const [t, v1] = h.headers["signed-md-signature"]!.split(",").map((p) => p.split("=")[1]!);
      expect(createHmac("sha256", secret).update(`${t}.${h.body}`).digest("hex")).toBe(v1);
    }
    const finalized = JSON.parse(hooks.at(-1)!.body);
    expect(finalized.data.metadata).toEqual({ customer_id: "acme", source: "sales-agent" });

    // 11. Download and independently verify the package.
    const zipRes = await fetch(finalized.data.artifact.url);
    const zip = new Uint8Array(await zipRes.arrayBuffer());
    const keys = await (await fetch(`${base}/.well-known/signed-md-keys.json`)).text();
    const report = verifyPackage(zip, { trustedKeys: trustedKeysFrom(keys) });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.trusted_key).toBe(true);
    if (!process.env.E2E_BASE_URL) {
      // Sealed PDF (PAdES) and trusted timestamps on both the seal and the package.
      expect(report.pdf_signature?.timestamp_authority).toContain("Test Timestamp Authority");
      expect(report.timestamp).not.toBeNull();
    } else {
      expect(report.pdf_signature).not.toBeNull();
    }
    if (SHOTS) {
      writeFileSync(join(SHOTS, "agreement.zip"), zip);
      writeFileSync(join(SHOTS, "signed-md-keys.json"), keys);
    }

    const artifacts = await call("signed_get_artifacts", { document_id: docId });
    expect(artifacts.data.data.map((a: any) => a.type)).toEqual(["pdf", "zip"]);
    const status = await call("signed_get_document", { document_id: docId });
    expect(status.data.status).toBe("finalized");

    await page.goto(`${base}/documents/${docId}`);
    await shot("09-finalized");

    // Teams: invite a member, who accepts and sees only their own work.
    await page.goto(`${base}/team`);
    await page.fill("input[name=email]", "mia@automaze.example");
    await page.selectOption("select[name=role]", "member");
    await page.click("button:has-text('Send invitation')");
    await page.waitForURL(/msg=invited/);
    await shot("13-team");
    let inviteUrl = "";
    for (let i = 0; i < 50 && !inviteUrl; i++) {
      await page.goto(`${base}/outbox`);
      const text = await page.locator("details").filter({ has: page.locator("summary", { hasText: "→ mia@automaze.example" }) }).first().locator("pre").textContent({ timeout: 500 }).catch(() => null);
      inviteUrl = (text && /\/invite\/([A-Za-z0-9_-]{30,})/.exec(text)?.[0]) ?? "";
      if (!inviteUrl) await new Promise((r) => setTimeout(r, 200));
    }
    expect(inviteUrl).toBeTruthy();
    const memberCtx = await browser.newContext();
    const member = await memberCtx.newPage();
    await member.goto(`${base}${inviteUrl}`);
    await member.fill("input[name=name]", "Mia Member");
    await member.fill("input[name=password]", "another good password");
    await member.click("button:has-text('Join Automaze')");
    await member.waitForURL(/\/documents/);
    expect(await member.locator(`a[href='/documents/${docId}']`).count()).toBe(0); // members see only their own documents
    expect(await member.locator("nav.side-nav a[href='/team']").count()).toBe(0);
    expect((await member.goto(`${base}/documents/${docId}`))!.status()).toBe(404);
    expect((await member.goto(`${base}/team`))!.status()).toBe(403);
    // A member's template waits for an owner.
    await member.goto(`${base}/templates/new`);
    await member.fill("input[name=name]", "Mia's NDA");
    await member.fill("textarea[name=source]", "# NDA\n\nSigned: {{a.signature:signature}}");
    await member.click("button:has-text('Save for approval')");
    await member.waitForSelector("text=Only an owner can approve it.");
    await memberCtx.close();
    await page.goto(`${base}/activity`);
    expect(await page.locator("text=joined as member").count()).toBe(1);
    await shot("14-activity");
    await page.goto(`${base}/documents`);
    await shot("10-documents");
    await mcp.close();
    await browser.close();
  }, 120_000);
});
