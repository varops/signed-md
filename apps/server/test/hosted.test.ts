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
    expect(plain).toContain(">Source</a>"); // self-hosted: the AGPL source link stays
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

describe("HOSTED", async () => {
  const SMTP = { SMTP_HOST: "smtp.host.example", SMTP_FROM: "Signed.md <no-reply@signed.md>" };
  const { ctx, user: owner } = await testContext({ HOSTED: "true", ...SMTP });
  afterAll(() => ctx.close());

  it("is off by default and needs SMTP from the environment", () => {
    expect(loadConfig({}).hosted).toBe(false);
    expect(() => loadConfig({ HOSTED: "true" })).toThrow(/HOSTED=true needs SMTP_HOST/);
    expect(loadConfig({ HOSTED: "true", ...SMTP }).hosted).toBe(true);
  });

  it("hides the signing key settings and the Outbox", async () => {
    const app = createApp(ctx);
    const cookie = `smd_session=${await createSession(ctx, owner.id)}`;
    const page = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(page).toContain("Your profile");
    expect(page).not.toContain("Signing key");
    // API keys and webhooks live on the Agents page.
    const agents = await (await app.request("/agentic", { headers: { cookie } })).text();
    expect(agents).toContain("API keys");
    expect(agents).toContain('action="/settings/webhook"');
    expect(page).not.toContain('href="/outbox"');
    expect((await app.request("/outbox", { headers: { cookie } })).status).toBe(404);
  });
});

describe("SMTP", async () => {
  const { ctx, user: owner } = await testContext();
  afterAll(() => ctx.close());

  it("can only be set in the environment, and old saved settings are dropped", async () => {
    const app = createApp(ctx);
    const cookie = `smd_session=${await createSession(ctx, owner.id)}`;
    const page = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(page).not.toContain("Email (SMTP)");
    expect(page).toContain("Signing key");
    expect(page).toContain('href="/outbox"');

    const { getAccount } = await import("../src/services/accounts.ts");
    const acct = await getAccount(ctx);
    await ctx.db.updateTable("accounts").set({ config: JSON.stringify({ ...acct.config, smtp: { host: "smtp.old.example", pass: "secret" } }) }).execute();
    expect("smtp" in (await getAccount(ctx)).config).toBe(false);
  });
});

describe("login with Google or Microsoft", () => {
  it("adds buttons next to the email login when the links are set", async () => {
    const { ctx } = await testContext({ OAUTH_GOOGLE_URL: "https://login.acme.example/google" });
    const page = await (await createApp(ctx).request("/login")).text();
    expect(page).toContain('href="https://login.acme.example/google?next=http%3A%2F%2Flocalhost%3A3999%2Fdocuments"');
    expect(page).not.toContain("Continue with Microsoft");
    expect(page).toContain('name="password"');
    await ctx.close();
  });

  it("default to app.signed.md when HOSTED, which keeps email login unless it is turned off", async () => {
    const hosted = loadConfig({ HOSTED: "true", SMTP_HOST: "smtp.x" });
    expect(hosted.oauth).toEqual({ google: "https://app.signed.md/oauth/google", microsoft: "https://app.signed.md/oauth/microsoft" });
    expect(hosted.allowEmailLogin).toBe(true);
    expect(loadConfig({}).allowEmailLogin).toBe(true);
    expect(() => loadConfig({ ALLOW_EMAIL_LOGIN: "false" })).toThrow(/needs OAUTH_GOOGLE_URL or OAUTH_MICROSOFT_URL/);
  });

  it("are the only way in with ALLOW_EMAIL_LOGIN=false", async () => {
    const { ctx, user } = await testContext({ HOSTED: "true", ALLOW_EMAIL_LOGIN: "false", SMTP_HOST: "smtp.host.example" });
    const app = createApp(ctx);
    const page = await (await app.request("/login")).text();
    expect(page).toContain("https://app.signed.md/oauth/google?next=");
    expect(page).toContain("https://app.signed.md/oauth/microsoft?next=");
    expect(page).not.toContain('name="password"');

    // No email login, no setup page, no password changes.
    expect((await app.request("/login", { method: "POST", body: new URLSearchParams({ email: "admin@automaze.example", password: "correct horse battery" }) })).headers.get("set-cookie")).toBeNull();
    expect((await app.request("/setup")).headers.get("location")).toBe("/login");
    const { changePassword, login } = await import("../src/services/auth.ts");
    expect(await login(ctx, "admin@automaze.example", "correct horse battery")).toBeNull();
    await expect(changePassword(ctx, user.id, "a new long password")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const settings = await (await app.request("/settings", { headers: { cookie: `smd_session=${await createSession(ctx, user.id)}` } })).text();
    expect(settings).not.toContain("Change password");
    await ctx.close();
  });

  it("lets invited people join without a password when email login is off", async () => {
    const { ctx, user } = await testContext({ ALLOW_EMAIL_LOGIN: "false", OAUTH_GOOGLE_URL: "https://login.acme.example/google" });
    const { inviteMember, acceptInvitation } = await import("../src/services/team.ts");
    await inviteMember(ctx, user, { email: "neo@x.example", role: "member" });
    const inv = await ctx.db.selectFrom("invitations").select("id").where("email", "=", "neo@x.example").executeTakeFirstOrThrow();
    // The invitation token is only in the email; mint one the same way the service does.
    const { randomToken, sha256 } = await import("../src/crypto.ts");
    const token = randomToken(24);
    await ctx.db.updateTable("invitations").set({ token_hash: sha256(token) }).where("id", "=", inv.id).execute();
    const page = await (await createApp(ctx).request(`/invite/${token}`)).text();
    expect(page).not.toContain('name="password"');
    const cookie = await acceptInvitation(ctx, token, { name: "Neo" });
    const { sessionActor } = await import("../src/services/auth.ts");
    expect((await sessionActor(ctx, cookie))?.label).toBe("neo@x.example");
    expect((await ctx.db.selectFrom("users").select("password_hash").where("email", "=", "neo@x.example").executeTakeFirstOrThrow()).password_hash).toBeNull();
    await ctx.close();
  });
});

describe("search engines", () => {
  it("keeps every page and response out of the index, but lets links be followed", async () => {
    const plain = await testContext();
    const app = createApp(plain.ctx);
    const login = await app.request("/login");
    expect(login.headers.get("x-robots-tag")).toBe("noindex, follow");
    expect(await login.text()).toContain('<meta name="robots" content="noindex, follow">');
    expect((await app.request("/skill.md")).headers.get("x-robots-tag")).toBe("noindex, follow");
    expect((await app.request("/s/not-a-real-token-but-long-enough-xxxx")).headers.get("x-robots-tag")).toBe("noindex, follow");
    await plain.ctx.close();
  });
});

describe("public footer", () => {
  it("shows Powered by with our logo, then the privacy policy when HOSTED or the source link otherwise", async () => {
    const hosted = await testContext({ HOSTED: "true", SMTP_HOST: "smtp.host.example" });
    const page = await (await createApp(hosted.ctx).request("/login")).text();
    expect(page).toContain('class="foot-logo"');
    expect(page).toContain('href="https://signed.md/privacy"');
    expect(page).not.toContain(">Source</a>");
    await hosted.ctx.close();
    const plain = await testContext();
    const own = await (await createApp(plain.ctx).request("/login")).text();
    expect(own).toContain('class="foot-logo"');
    expect(own).toContain(">Source</a>");
    expect(own).not.toContain("signed.md/privacy");
    await plain.ctx.close();
  });
});

describe("account menu", () => {
  it("shows the person in the sidebar, with Manage account when HOSTED and their settings otherwise", async () => {
    const hosted = await testContext({ HOSTED: "true", SMTP_HOST: "smtp.host.example" });
    const page = await (await createApp(hosted.ctx).request("/documents", { headers: { cookie: `smd_session=${await createSession(hosted.ctx, hosted.user.id)}` } })).text();
    expect(page).toContain('class="user-menu"');
    expect(page).toContain('href="https://app.signed.md/account"');
    expect(page).toMatch(/action="\/logout"/);
    expect(page).toContain("unavatar.io/admin%40automaze.example");
    expect(page).not.toContain(">Outbox<");
    await hosted.ctx.close();

    const plain = await testContext();
    const own = await (await createApp(plain.ctx).request("/documents", { headers: { cookie: `smd_session=${await createSession(plain.ctx, plain.user.id)}` } })).text();
    expect(own).toContain('class="user-menu"');
    expect(own).toMatch(/action="\/logout"/);
    expect(own).not.toContain("app.signed.md/account");
    expect(own).toContain(">Outbox<");
    await plain.ctx.close();
  });
});
