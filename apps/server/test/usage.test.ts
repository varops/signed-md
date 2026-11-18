import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createApiKey, createSession } from "../src/services/auth.ts";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { currentPeriod, getUsage } from "../src/services/usage.ts";
import { testContext } from "./helpers.ts";

// Plan limits on sent contracts (hosted service). Not in the public docs.

const inline = (n: number) => ({ content: `# NDA ${n}\n\n{{a.signature:signature}}`, signers: [{ key: "a", name: "Ann", email: `ann${n}@client.example` }] });

describe("limit settings", () => {
  it("default to no limit and reject nonsense", () => {
    expect(loadConfig({})).toMatchObject({ monthlyLimit: -1, totalLimit: -1 });
    expect(loadConfig({ MONTHLY_LIMIT: "20", TOTAL_LIMIT: "10" })).toMatchObject({ monthlyLimit: 20, totalLimit: 10 });
    expect(() => loadConfig({ MONTHLY_LIMIT: "ten" })).toThrow(ConfigError);
    expect(() => loadConfig({ TOTAL_LIMIT: "-2" })).toThrow(ConfigError);
  });
});

describe("without limits", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());

  it("still counts sent contracts, and never blocks", async () => {
    for (const n of [1, 2, 3]) {
      const d = await createDocument(ctx, user, inline(n));
      await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision });
    }
    await createDocument(ctx, user, inline(4)); // drafts don't count
    expect(await getUsage(ctx.db)).toEqual({ month: 3, total: 3 });
  });
});

describe("MONTHLY_LIMIT", async () => {
  const { ctx, user } = await testContext({ MONTHLY_LIMIT: "2" });
  afterAll(() => ctx.close());

  it("blocks creating and sending once this month's limit is used", async () => {
    // Last month's sends don't count towards this month, only towards the total.
    await ctx.db.insertInto("usage_counters").values({ period: "2020-01", sent: 50 }).execute();
    const drafts = [];
    for (const n of [1, 2, 3]) drafts.push(await createDocument(ctx, user, inline(n)));
    for (const d of drafts.slice(0, 2)) await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision });
    expect(await getUsage(ctx.db)).toEqual({ month: 2, total: 52 });

    const third = drafts[2]!;
    await expect(sendDocument(ctx, user, third.id, { approved_revision: (await previewDocument(ctx, user, third.id)).revision })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    await expect(createDocument(ctx, user, inline(4))).rejects.toThrow(/sent its 2 contracts for this month.*app\.signed\.md\/billing\?reason=limit&workspace=localhost%3A3999/);
    expect((await ctx.db.selectFrom("usage_counters").selectAll().where("period", "=", currentPeriod()).executeTakeFirst())?.sent).toBe(2);
  });

  it("shows an upgrade link in the UI and returns 402 on the API", async () => {
    const app = createApp(ctx);
    const cookie = `smd_session=${await createSession(ctx, user.id)}`;
    for (const path of ["/documents", "/documents/new"]) {
      const page = await (await app.request(path, { headers: { cookie } })).text();
      expect(page).toContain("Upgrade plan");
      expect(page).toContain("https://app.signed.md/billing?reason=limit&amp;workspace=localhost%3A3999");
    }
    const key = (await createApiKey(ctx, user, "agent")).key;
    const res = await app.request("/v1/documents", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(inline(5)) });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LIMIT_REACHED");
  });
});

describe("TOTAL_LIMIT", async () => {
  const { ctx, user } = await testContext({ TOTAL_LIMIT: "10", MONTHLY_LIMIT: "100" });
  afterAll(() => ctx.close());

  it("blocks once all contracts in the plan are used, across months", async () => {
    await ctx.db.insertInto("usage_counters").values({ period: "2020-01", sent: 9 }).execute();
    const d = await createDocument(ctx, user, inline(1));
    await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision });
    await expect(createDocument(ctx, user, inline(2))).rejects.toThrow(/used all 10 contracts in its plan/);
  });
});

describe("contracts left", () => {
  it("is hidden without limits, and follows the tightest limit", async () => {
    const { remaining } = await import("../src/services/usage.ts");
    const none = await testContext();
    expect(await remaining(none.ctx)).toBeNull();
    await none.ctx.close();

    const { ctx } = await testContext({ TOTAL_LIMIT: "10", MONTHLY_LIMIT: "5" });
    expect(await remaining(ctx)).toMatchObject({ kind: "monthly", limit: 5, left: 5, level: "ok" });
    await ctx.db.insertInto("usage_counters").values({ period: "2020-01", sent: 7 }).execute();
    expect(await remaining(ctx)).toMatchObject({ kind: "total", limit: 10, left: 3, level: "ok" });
    await ctx.db.insertInto("usage_counters").values({ period: currentPeriod(), sent: 1 }).execute();
    expect(await remaining(ctx)).toMatchObject({ kind: "total", left: 2, level: "low" });
    await ctx.db.updateTable("usage_counters").set({ sent: 3 }).where("period", "=", currentPeriod()).execute();
    const out = await remaining(ctx);
    expect(out).toMatchObject({ kind: "total", left: 0, level: "out" });
    expect(out!.url).toContain("reason=limit");
    await ctx.close();
  });

  it("shows a pill in the top bar for people who can send", async () => {
    const { ctx, user } = await testContext({ TOTAL_LIMIT: "10" });
    await ctx.db.insertInto("usage_counters").values({ period: currentPeriod(), sent: 3 }).execute();
    const app = createApp(ctx);
    const page = await (await app.request("/documents", { headers: { cookie: `smd_session=${await createSession(ctx, user.id)}` } })).text();
    expect(page).toContain('class="usage-pill" data-level="ok"');
    expect(page).toContain(">7 of 10 left<");
    expect(page).toContain("billing?reason=usage&amp;workspace=localhost%3A3999");

    const { newId, now } = await import("@signed-md/db");
    const vid = newId("usr");
    await ctx.db.insertInto("users").values({ id: vid, account_id: user.accountId, email: "vic@x.example", name: "Vic", role: "viewer", password_hash: null, status: "active", created_at: now() } as never).execute();
    const viewer = await (await app.request("/documents", { headers: { cookie: `smd_session=${await createSession(ctx, vid)}` } })).text();
    expect(viewer).not.toContain("usage-pill");
    await ctx.close();
  });
});
