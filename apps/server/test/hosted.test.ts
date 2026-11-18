import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { apiKeyActor, createApiKey, login, sessionActor, createSession } from "../src/services/auth.ts";
import { createDocument, getDocument, listDocuments, previewDocument, sendDocument } from "../src/services/documents.ts";
import { renderEmail } from "../src/services/emailtemplate.ts";
import { setAccountActive } from "../src/services/permissions.ts";
import { submitSignature } from "../src/services/signing.ts";
import * as team from "../src/services/team.ts";
import { setBranding, footer } from "../src/ui/layout.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

// Hidden settings for the hosted service: BRANDING and ACTIVE. Not in the public docs.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const meta = { ip: "203.0.113.7", user_agent: "vitest" };

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
  afterAll(() => {
    setAccountActive(true);
    return ctx.close();
  });

  // Set up while active: a member with a session and an API key, and a document out for signing.
  await team.inviteMember(ctx, owner, { email: "mia@x.example", role: "member" });
  await drainJobs(ctx);
  const mails = () => readdirSync(join(dataDir, "outbox")).sort().map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { to: string; text: string });
  const invite = /\/invite\/([A-Za-z0-9_-]+)/.exec(mails().find((m) => m.to === "mia@x.example")!.text)![1]!;
  await team.acceptInvitation(ctx, invite, { name: "Mia Member", password: "long enough password" });
  const miaId = (await team.listMembers(ctx)).find((m) => m.email === "mia@x.example")!.id;
  const mia = { kind: "user" as const, id: miaId, accountId: owner.accountId, label: "mia@x.example", name: "Mia Member", role: "member" as const };
  const miaSession = await createSession(ctx, miaId);
  const miaKey = (await createApiKey(ctx, mia, "mia")).key;
  const ownerKey = (await createApiKey(ctx, owner, "owner")).key;
  await team.inviteMember(ctx, owner, { email: "late@x.example", role: "member" });
  await drainJobs(ctx);
  const lateInvite = /\/invite\/([A-Za-z0-9_-]+)/.exec(mails().find((m) => m.to === "late@x.example")!.text)![1]!;
  const doc = await createDocument(ctx, owner, { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "Ann", email: "ann@client.example" }] });
  await sendDocument(ctx, owner, doc.id, { approved_revision: (await previewDocument(ctx, owner, doc.id)).revision });
  await drainJobs(ctx);
  const signerToken = /\/s\/([A-Za-z0-9_-]+)/.exec(mails().find((m) => m.to === "ann@client.example")!.text)![1]!;

  setAccountActive(false);

  it("lets only owners log in, and only to read", async () => {
    await expect(login(ctx, "mia@x.example", "long enough password")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await sessionActor(ctx, miaSession)).toBeNull();
    await expect(apiKeyActor(ctx, miaKey, "api")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(team.acceptInvitation(ctx, lateInvite, { name: "Late", password: "long enough password" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    expect(await login(ctx, "admin@automaze.example", "correct horse battery")).not.toBeNull();
    expect(await apiKeyActor(ctx, ownerKey, "api")).not.toBeNull();
    expect((await listDocuments(ctx, owner)).data.map((d) => d.id)).toContain(doc.id);
    expect((await getDocument(ctx, owner, doc.id)).id).toBe(doc.id);
    await expect(createDocument(ctx, owner, { content: "# X", signers: [] })).rejects.toThrow(/This account is disabled/);
    await expect(team.inviteMember(ctx, owner, { email: "new@x.example", role: "member" })).rejects.toThrow(/This account is disabled/);
  });

  it("lets signers finish documents already sent", async () => {
    const r = await submitSignature(ctx, signerToken, { consent: true, fields: { "a.signature": { kind: "drawn", image: PNG } } }, meta);
    expect(r.document_status).toBe("signed");
    await drainJobs(ctx);
    expect((await getDocument(ctx, owner, doc.id)).status).toBe("finalized");
  }, 60_000);

  it("shows owners a banner, refuses members at the login page, and refuses member API keys", async () => {
    const app = createApp(ctx);
    const res = await app.request("/login", { method: "POST", body: new URLSearchParams({ email: "mia@x.example", password: "long enough password" }) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This account is disabled.");

    const api = await app.request("/v1/documents", { headers: { authorization: `Bearer ${miaKey}` } });
    expect(api.status).toBe(403);
    const mcp = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${miaKey}`, "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(403);

    const ownerSession = await createSession(ctx, owner.id);
    const page = await app.request("/documents", { headers: { cookie: `smd_session=${ownerSession}` } });
    expect(await page.text()).toContain("This account is disabled. Owners can still log in");
  });
});
