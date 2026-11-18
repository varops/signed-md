import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createApiKey, createSession } from "../src/services/auth.ts";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { renderEmail } from "../src/services/emailtemplate.ts";
import { setBranding, footer } from "../src/ui/layout.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

// Hidden settings for the hosted service: BRANDING and ACTIVE. Not in the public docs.

describe("BRANDING", () => {
  it("is on by default", () => {
    expect(loadConfig({}).branding).toBe(true);
    expect(loadConfig({ BRANDING: "false" }).branding).toBe(false);
  });

  it("links to signed.md from emails and pages only when on", async () => {
    const base = { account: "Acme", hasLogo: false, icon: "document" as const, headline: "Hi" };
    const on = renderEmail(base);
    expect(on.html).toContain('href="https://signed.md"');
    expect(on.text).toContain("Sent by Acme with Signed.md (https://signed.md).");
    const off = renderEmail({ ...base, branding: false });
    expect(off.html).not.toContain("signed.md");
    expect(off.html).toContain("Sent by Acme.");
    expect(off.text).not.toContain("Signed.md");

    setBranding(true);
    expect(String(await footer())).toContain("Powered by");
    setBranding(false);
    const plain = String(await footer());
    expect(plain).not.toContain("Powered by");
    expect(plain).toContain("Source"); // the AGPL source link always stays
    setBranding(true);
  });
});

describe("ACTIVE=false", async () => {
  const { ctx, user: owner, dataDir } = await testContext();
  afterAll(() => ctx.close());

  // While active: an API key and a document out for signing.
  const key = (await createApiKey(ctx, owner, "owner")).key;
  const doc = await createDocument(ctx, owner, { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "Ann", email: "ann@client.example" }] });
  await sendDocument(ctx, owner, doc.id, { approved_revision: (await previewDocument(ctx, owner, doc.id)).revision });
  await drainJobs(ctx);
  const mail = readdirSync(join(dataDir, "outbox")).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { to: string; text: string }).find((m) => m.to === "ann@client.example")!;
  const signingPath = /\/s\/[A-Za-z0-9_-]+/.exec(mail.text)![0];
  const session = await createSession(ctx, owner.id);

  it("defaults to active", () => {
    expect(loadConfig({}).active).toBe(true);
    expect(loadConfig({ ACTIVE: "false" }).active).toBe(false);
  });

  it("works normally while active", async () => {
    const app = createApp(ctx);
    expect((await app.request(signingPath)).status).toBe(200);
    expect((await app.request("/v1/documents", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });

  it("blocks logins, the API, MCP and signing links, but not health, keys or assets", async () => {
    const app = createApp({ ...ctx, config: { ...ctx.config, active: false } });
    for (const path of ["/login", "/setup", "/documents", signingPath]) {
      const res = await app.request(path, { headers: { cookie: `smd_session=${session}` } });
      expect(res.status, path).toBe(403);
      expect(await res.text()).toContain("This account is disabled.");
    }
    const login = await app.request("/login", { method: "POST", body: new URLSearchParams({ email: "admin@automaze.example", password: "correct horse battery" }) });
    expect(login.status).toBe(403);
    const api = await app.request("/v1/documents", { headers: { authorization: `Bearer ${key}` } });
    expect(api.status).toBe(403);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe("PERMISSION_DENIED");
    const mcp = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(403);

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/.well-known/signed-md-keys.json")).status).toBe(200);
    expect((await app.request("/assets/app.css")).status).toBe(200);
  });
});
