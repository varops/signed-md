import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { readSessionCookie, SESSION_SECONDS, sessionActor, sessionCookie } from "../src/services/auth.ts";
import * as team from "../src/services/team.ts";
import { testContext } from "./helpers.ts";

const EMAIL = "admin@automaze.example";

describe("login cookie", async () => {
  const KEY = "k".repeat(40);
  const { ctx, user } = await testContext({ COOKIE_HASH_KEY: KEY, COOKIE_DOMAIN: "localhost" });
  afterAll(() => ctx.close());

  it("is email, expiry and an HMAC that anyone with the key can write", async () => {
    // What app.signed.md would write, with the same key.
    const exp = Math.floor(Date.now() / 1000) + 600;
    const body = `v1.${Buffer.from(EMAIL).toString("base64url")}.${exp}`;
    const outside = `${body}.${createHmac("sha256", KEY).update(body).digest("hex")}`;
    expect((await sessionActor(ctx, outside))?.id).toBe(user.id);
    expect(readSessionCookie(ctx, sessionCookie(ctx, EMAIL))).toBe(EMAIL);
  });

  it("rejects forged, edited and expired cookies", async () => {
    const good = sessionCookie(ctx, EMAIL);
    const [v, , exp, sig] = good.split(".");
    expect(await sessionActor(ctx, `${v}.${Buffer.from("ceo@automaze.example").toString("base64url")}.${exp}.${sig}`)).toBeNull();
    expect(await sessionActor(ctx, good.replace(/\.\d+\./, `.${Number(exp) + 99999}.`))).toBeNull();
    const old = sessionCookie(ctx, EMAIL, Date.now() - (SESSION_SECONDS + 1) * 1000);
    expect(await sessionActor(ctx, old)).toBeNull();
    expect(await sessionActor(ctx, "garbage")).toBeNull();
  });

  it("is renewed for another hour on every visit, on the configured domain", async () => {
    const app = createApp(ctx);
    const res = await app.request("/documents", { headers: { cookie: `smd_session=${sessionCookie(ctx, EMAIL, Date.now() - 1800_000)}` } });
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/Max-Age=3600/);
    expect(set).toMatch(/Domain=localhost/);
    const renewed = /smd_session=([^;]+)/.exec(set)![1]!;
    expect(Number(renewed.split(".")[2]) * 1000).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("stops working at once when the person is deactivated", async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.ts");
    const { newId, now } = await import("@signed-md/db");
    const deeId = newId("usr");
    await ctx.db.insertInto("users").values({ id: deeId, account_id: user.accountId, email: "dee@x.example", name: "Dee", role: "member", password_hash: await hashPassword("long enough password"), status: "active", created_at: now() } as never).execute();
    const cookie = await createSession(ctx, deeId);
    expect(await sessionActor(ctx, cookie)).not.toBeNull();
    await team.deactivateMember(ctx, user, deeId);
    expect(await sessionActor(ctx, cookie)).toBeNull();
  });
});

describe("cookie settings", () => {
  it("check the domain and key", () => {
    expect(loadConfig({}).cookieDomain).toBeNull();
    expect(loadConfig({ PUBLIC_URL: "https://acme.signed.md", COOKIE_DOMAIN: ".signed.md" }).cookieDomain).toBe(".signed.md");
    expect(() => loadConfig({ PUBLIC_URL: "https://acme.signed.md", COOKIE_DOMAIN: ".other.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ COOKIE_HASH_KEY: "short" })).toThrow(ConfigError);
  });
});
