import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { unseal } from "../src/crypto.ts";
import { login } from "../src/services/auth.ts";
import { type EmailJob, sendEmailJob } from "../src/services/emails.ts";
import type { MailMessage } from "../src/services/mail.ts";
import { canEmailResets, findPasswordReset, passwordResetLink, requestPasswordReset, resetPassword } from "../src/services/passwordreset.ts";
import { testContext } from "./helpers.ts";

const EMAIL = "admin@automaze.example";

describe("password reset", async () => {
  const { ctx } = await testContext({ SMTP_HOST: "smtp.invalid" });
  const sent: MailMessage[] = [];
  ctx.mailer.send = async (m: MailMessage) => {
    sent.push(m);
    return "smtp";
  };
  afterAll(() => ctx.close());

  const lastJob = async () => {
    const row = await ctx.db.selectFrom("jobs").select("payload").where("type", "=", "email").orderBy("run_at", "desc").executeTakeFirstOrThrow();
    const job = JSON.parse(row.payload) as EmailJob & { reset_id: string };
    return { job, token: unseal(ctx.keys.serverSecret, job.link!).split("/reset/")[1]! };
  };

  it("emails a one-time link and sets the new password", async () => {
    await requestPasswordReset(ctx, `  ${EMAIL.toUpperCase()} `);
    const { job, token } = await lastJob();
    expect(job.kind).toBe("password_reset");
    await sendEmailJob(ctx, job);
    expect(sent.at(-1)?.to).toBe(EMAIL);
    expect(sent.at(-1)?.text).toContain(`/reset/${token}`);

    expect((await findPasswordReset(ctx, token))?.email).toBe(EMAIL);
    await expect(resetPassword(ctx, token, "short")).rejects.toThrow(/at least 10/);
    const cookie = await resetPassword(ctx, token, "a brand new password");
    expect(cookie).toMatch(/^v1\./);
    expect(await login(ctx, EMAIL, "a brand new password")).not.toBeNull();
    expect(await login(ctx, EMAIL, "correct horse battery")).toBeNull();
    // Used up.
    expect(await findPasswordReset(ctx, token)).toBeNull();
    await expect(resetPassword(ctx, token, "another new password")).rejects.toThrow(/expired or was already used/);
    const audit = await ctx.db.selectFrom("audit_events").select("type").where("type", "=", "password.reset").execute();
    expect(audit).toHaveLength(1);
  });

  it("says nothing about unknown emails, throttles, and cancels older links", async () => {
    const before = (await ctx.db.selectFrom("jobs").select("id").execute()).length;
    await requestPasswordReset(ctx, "nobody@automaze.example");
    expect((await ctx.db.selectFrom("jobs").select("id").execute()).length).toBe(before);

    // The test above made a link less than a minute ago, so this one is throttled.
    await requestPasswordReset(ctx, EMAIL);
    expect((await ctx.db.selectFrom("jobs").select("id").execute()).length).toBe(before);

    const first = (await passwordResetLink(ctx, EMAIL)).split("/reset/")[1]!;
    const second = (await passwordResetLink(ctx, EMAIL)).split("/reset/")[1]!;
    expect(await findPasswordReset(ctx, first)).toBeNull();
    expect(await findPasswordReset(ctx, second)).not.toBeNull();
    expect(await findPasswordReset(ctx, "not-a-real-token-at-all-1234")).toBeNull();
  });

  it("doesn't email links without SMTP (the Outbox is visible to administrators)", async () => {
    const plain = await testContext();
    try {
      expect(canEmailResets(plain.ctx)).toBe(false);
      await requestPasswordReset(plain.ctx, EMAIL);
      expect(await plain.ctx.db.selectFrom("password_resets").select("id").execute()).toHaveLength(0);
      const page = await (await createApp(plain.ctx).request("/forgot")).text();
      expect(page).toContain("can't send email yet");
    } finally {
      await plain.ctx.close();
    }
  });

  it("works through the pages, which never reveal whether an account exists", async () => {
    const app = createApp(ctx);
    const loginPage = await (await app.request("/login")).text();
    expect(loginPage).toContain('href="/forgot"');
    expect(loginPage).not.toContain('class="brand"'); // no logo above the form: the footer carries it
    expect(loginPage).toContain('class="foot-logo"');
    const known = await (await app.request("/forgot", { method: "POST", body: new URLSearchParams({ email: EMAIL }) })).text();
    const unknown = await (await app.request("/forgot", { method: "POST", body: new URLSearchParams({ email: "nobody@automaze.example" }) })).text();
    expect(known.replace(EMAIL, "X")).toBe(unknown.replace("nobody@automaze.example", "X"));

    const token = (await passwordResetLink(ctx, EMAIL)).split("/reset/")[1]!;
    const form = await app.request(`/reset/${token}`);
    expect(form.status).toBe(200);
    expect(form.headers.get("cache-control")).toBe("no-store");
    const done = await app.request(`/reset/${token}`, { method: "POST", body: new URLSearchParams({ password: "yet another password" }) });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/documents?msg=password");
    expect(done.headers.get("set-cookie")).toContain("smd_session=v1.");
    expect((await app.request(`/reset/${token}`)).status).toBe(404);
  });
});
