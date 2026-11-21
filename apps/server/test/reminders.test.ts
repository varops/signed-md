import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addBusinessDays, isBusinessDay, reminderLabel } from "@signed-md/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getAccount, updateAccount } from "../src/services/accounts.ts";
import { createDocument, getDocument, previewDocument, resendToSigner, sendDocument, updateDocument } from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { sendReminders } from "../src/services/reminders.ts";
import { openSigningPage, submitSignature } from "../src/services/signing.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const at = (iso: string) => new Date(iso);

describe("business days", () => {
  it("skip weekends in the given timezone", () => {
    // Monday 2 November 2026, 10:00 UTC.
    expect(addBusinessDays(at("2026-11-02T10:00:00Z"), 3, "UTC").toISOString()).toBe("2026-11-05T10:00:00.000Z");
    // Friday plus 3 business days is Wednesday.
    expect(addBusinessDays(at("2026-11-06T10:00:00Z"), 3, "UTC").toISOString()).toBe("2026-11-11T10:00:00.000Z");
    // A Saturday start counts from Monday.
    expect(addBusinessDays(at("2026-11-07T10:00:00Z"), 3, "UTC").toISOString()).toBe("2026-11-11T10:00:00.000Z");
    // Friday 20:00 UTC is already Saturday morning in Auckland.
    expect(isBusinessDay(at("2026-11-06T20:00:00Z"), "UTC")).toBe(true);
    expect(isBusinessDay(at("2026-11-06T20:00:00Z"), "Pacific/Auckland")).toBe(false);
  });

  it("number reminder subjects", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(reminderLabel)).toEqual([
      "REMINDER",
      "2ND REMINDER",
      "3RD REMINDER",
      "4TH REMINDER",
      "11TH REMINDER",
      "12TH REMINDER",
      "13TH REMINDER",
      "21ST REMINDER",
      "22ND REMINDER",
    ]);
  });
});

describe("automatic reminders", async () => {
  const { ctx, user, dataDir } = await testContext();
  afterAll(() => ctx.close());

  const mails = (to: string) =>
    readdirSync(join(dataDir, "outbox"))
      .map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { to: string; subject: string; text: string; created_at: string })
      .filter((m) => m.to === to)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastReminder = (to: string) => mails(to).filter((m) => m.subject.includes("REMINDER")).at(-1)!;
  const reminders = (to: string) => mails(to).filter((m) => m.subject.includes("REMINDER")).length;
  const linkIn = (text: string) => /\/s\/([A-Za-z0-9_-]+)/.exec(text)![1]!;

  async function sentDocument(email: string, extra: { reminders?: boolean; signers?: { key: string; name: string; email: string; order?: number }[] } = {}) {
    const signers = extra.signers ?? [{ key: "a", name: "A", email }];
    const content = `# NDA\n\n${signers.map((s) => `{{${s.key}.signature:signature}}`).join("\n\n")}`;
    const doc = await createDocument(ctx, user, { content, signers, ...(extra.reminders !== undefined ? { reminders: extra.reminders } : {}) });
    await sendDocument(ctx, user, doc.id, { approved_revision: (await previewDocument(ctx, user, doc.id)).revision });
    await drainJobs(ctx);
    // Pretend the signing emails went out on Monday 2 November 2026 at 10:00 UTC.
    await ctx.db.updateTable("signers").set({ notified_at: "2026-11-02T10:00:00.000Z" }).where("document_id", "=", doc.id).execute();
    return doc;
  }

  it("are on for new accounts and new documents", async () => {
    expect((await getAccount(ctx)).config.reminders).toBe(true);
    const doc = await createDocument(ctx, user, { content: "# X\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "x@client.example" }] });
    expect(doc.reminders).toBe(true);
  });

  it("go out every 3 business days with the same link, numbered in the subject", async () => {
    const doc = await sentDocument("r1@client.example");
    const first = mails("r1@client.example");
    expect(first).toHaveLength(1);
    const link = linkIn(first[0]!.text);

    expect(await sendReminders(ctx, at("2026-11-04T10:00:00Z"))).toBe(0); // Wednesday: too early
    expect(await sendReminders(ctx, at("2026-11-05T10:00:00Z"))).toBe(1); // Thursday: due
    expect(await sendReminders(ctx, at("2026-11-05T10:01:00Z"))).toBe(0); // never twice
    await drainJobs(ctx);
    let m = mails("r1@client.example");
    expect(m).toHaveLength(2);
    expect(m[1]!.subject).toBe("REMINDER: Please sign: NDA");
    expect(linkIn(m[1]!.text)).toBe(link);
    expect(m[1]!.text).not.toContain("This is a new link");

    // Thursday plus 3 business days is Tuesday. The weekend in between sends nothing.
    expect(await sendReminders(ctx, at("2026-11-07T12:00:00Z"))).toBe(0);
    expect(await sendReminders(ctx, at("2026-11-10T10:00:00Z"))).toBe(1);
    await drainJobs(ctx);
    m = mails("r1@client.example");
    expect(m[2]!.subject).toBe("2ND REMINDER: Please sign: NDA");
    expect(linkIn(m[2]!.text)).toBe(link);

    // The first email's link still works.
    expect((await openSigningPage(ctx, link, { ip: "203.0.113.7", user_agent: "vitest" })).state).toBe("sign");

    const view = await getDocument(ctx, user, doc.id);
    expect(view.signers[0]!.reminders_sent).toBe(2);
    const events = await listEvents(ctx.db, doc.id);
    expect(events.filter((e) => e.type === "signer.reminded").map((e) => e.data.reminder)).toEqual([1, 2]);
  });

  it("are not sent on weekends, even when they are overdue", async () => {
    await sentDocument("wk@client.example");
    await sendReminders(ctx, at("2026-11-14T10:00:00Z")); // Saturday
    await drainJobs(ctx);
    expect(reminders("wk@client.example")).toBe(0);
    await sendReminders(ctx, at("2026-11-16T09:00:00Z")); // Monday: one reminder, not a burst
    await drainJobs(ctx);
    expect(reminders("wk@client.example")).toBe(1);
  });

  it("count a manual resend, which makes a new link that later reminders reuse", async () => {
    const doc = await sentDocument("man@client.example");
    const original = linkIn(mails("man@client.example")[0]!.text);
    // Manual resends are limited to one a minute after the last link.
    await ctx.db.updateTable("events").set({ created_at: "2026-11-02T10:00:00.000Z" }).where("document_id", "=", doc.id).execute();
    await resendToSigner(ctx, user, doc.id, "a");
    await drainJobs(ctx);
    const resent = mails("man@client.example")[1]!;
    expect(resent.subject).toBe("REMINDER: Please sign: NDA");
    expect(resent.text).toContain("This is a new link");
    const fresh = linkIn(resent.text);
    expect(fresh).not.toBe(original);
    expect((await openSigningPage(ctx, original, { ip: "203.0.113.7", user_agent: "vitest" })).state).toBe("invalid");

    // The next automatic one waits 3 business days from the resend, then reuses the new link.
    const resentAt = (await getDocument(ctx, user, doc.id)).signers[0]!.last_reminded_at!;
    const due = addBusinessDays(at(resentAt), 3, "UTC");
    await sendReminders(ctx, new Date(due.getTime() - 60_000));
    await drainJobs(ctx);
    expect(reminders("man@client.example")).toBe(1);
    const ok = isBusinessDay(due, "UTC") ? due : addBusinessDays(due, 1, "UTC");
    await sendReminders(ctx, ok);
    await drainJobs(ctx);
    expect(reminders("man@client.example")).toBe(2);
    const next = mails("man@client.example")[2]!;
    expect(next.subject).toBe("2ND REMINDER: Please sign: NDA");
    expect(linkIn(next.text)).toBe(fresh);
  });

  it("stop when the signer has signed, and skip documents with reminders off", async () => {
    const off = await sentDocument("off@client.example", { reminders: false });
    expect((await getDocument(ctx, user, off.id)).reminders).toBe(false);
    const done = await sentDocument("done@client.example");
    const link = linkIn(mails("done@client.example")[0]!.text);
    const meta = { ip: "203.0.113.7", user_agent: "vitest" };
    await submitSignature(ctx, link, { consent: true, fields: { "a.signature": { kind: "typed", text: "Done" } } }, meta);
    expect((await getDocument(ctx, user, done.id)).signers[0]!.status).toBe("signed");
    await sendReminders(ctx, at("2026-11-05T10:00:00Z"));
    await drainJobs(ctx);
    expect(reminders("off@client.example") + reminders("done@client.example")).toBe(0);
  });

  it("change the revision, so turning them on or off needs a new preview", async () => {
    const doc = await createDocument(ctx, user, { content: "# Y\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "y@client.example" }] });
    const before = doc.revision;
    const off = await updateDocument(ctx, user, doc.id, { reminders: false });
    expect(off.reminders).toBe(false);
    expect(off.revision).not.toBe(before);
  });

  it("default to off when the account setting is off", async () => {
    await updateAccount(ctx, user, { config: { reminders: false } });
    const doc = await createDocument(ctx, user, { content: "# Z\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "z@client.example" }] });
    expect(doc.reminders).toBe(false);
    await updateAccount(ctx, user, { config: { reminders: true } });
  });

  it("let the last signer's nudge carry their link", async () => {
    await sentDocument("p1@client.example", {
      signers: [
        { key: "a", name: "A", email: "p1@client.example" },
        { key: "b", name: "B", email: "p2@client.example" },
      ],
    });
    const linkA = linkIn(mails("p1@client.example")[0]!.text);
    const linkB = linkIn(mails("p2@client.example")[0]!.text);
    await submitSignature(ctx, linkA, { consent: true, fields: { "a.signature": { kind: "typed", text: "A" } } }, { ip: "203.0.113.7", user_agent: "vitest" });
    await drainJobs(ctx);
    const nudge = mails("p2@client.example").find((m) => m.subject.startsWith("Waiting for you"))!;
    expect(linkIn(nudge.text)).toBe(linkB);
  });

  it("send documents from before reminders existed a new link", async () => {
    const doc = await sentDocument("old@client.example");
    await ctx.db.updateTable("signers").set({ link_sealed: null }).where("document_id", "=", doc.id).execute();
    const original = linkIn(mails("old@client.example")[0]!.text);
    expect(await sendReminders(ctx, at("2026-11-05T10:00:00Z"))).toBeGreaterThanOrEqual(1);
    await drainJobs(ctx);
    const reminder = mails("old@client.example")[1]!;
    expect(reminder.subject).toBe("REMINDER: Please sign: NDA");
    expect(reminder.text).toContain("This is a new link");
    expect(linkIn(reminder.text)).not.toBe(original);
  });

  describe("before the deadline", () => {
    const deadline = async (email: string, expires: string, notified = "2026-11-02T10:00:00.000Z") => {
      const doc = await sentDocument(email);
      await ctx.db.updateTable("documents").set({ expires_at: expires }).where("id", "=", doc.id).execute();
      await ctx.db.updateTable("signers").set({ notified_at: notified }).where("document_id", "=", doc.id).execute();
      return doc;
    };
    // The email worker checks the deadline against the clock, so the clock follows the test.
    const send = async (iso: string) => {
      vi.useFakeTimers({ toFake: ["Date"], now: at(iso) });
      try {
        await sendReminders(ctx, at(iso));
        await drainJobs(ctx);
      } finally {
        vi.useRealTimers();
      }
    };

    it("go out 24 hours and 1 hour before it, after the regular ones stop", async () => {
      const doc = await deadline("dl@client.example", "2026-11-16T17:00:00.000Z"); // Monday 17:00
      const link = linkIn(mails("dl@client.example")[0]!.text);
      await send("2026-11-05T10:00:00Z"); // regular, Thursday
      await send("2026-11-10T10:00:00Z"); // regular, Tuesday: 6 days before the deadline
      expect(reminders("dl@client.example")).toBe(2);
      await send("2026-11-13T10:00:00Z"); // the next regular one is due Friday, but the deadline is under 4 days away
      expect(reminders("dl@client.example")).toBe(2);
      await send("2026-11-15T16:59:00Z");
      expect(reminders("dl@client.example")).toBe(2);
      await send("2026-11-15T17:00:00Z"); // Sunday: 24 hours before
      await send("2026-11-15T17:30:00Z");
      let m = mails("dl@client.example").filter((x) => x.subject.includes("REMINDER"));
      expect(m).toHaveLength(3);
      expect(m[2]!.subject).toBe("3RD REMINDER: Please sign: NDA – expires in 24 hours");
      expect(m[2]!.text).toContain("expires in about 24 hours");
      expect(linkIn(m[2]!.text)).toBe(link);
      await send("2026-11-16T15:59:00Z");
      expect(reminders("dl@client.example")).toBe(3);
      await send("2026-11-16T16:00:00Z");
      await send("2026-11-16T16:30:00Z");
      m = mails("dl@client.example").filter((x) => x.subject.includes("REMINDER"));
      expect(m).toHaveLength(4);
      expect(m[3]!.subject).toBe("4TH REMINDER: Please sign: NDA – expires in 1 hour");
      expect(linkIn(m[3]!.text)).toBe(link);
      const events = await listEvents(ctx.db, doc.id);
      expect(events.filter((e) => e.type === "signer.reminded").map((e) => e.data.hours_before_expiry ?? null)).toEqual([null, null, 24, 1]);
    });

    it("also go out on weekends", async () => {
      await deadline("dlwk@client.example", "2026-11-15T12:00:00.000Z", "2026-11-12T10:00:00.000Z"); // Sunday noon
      await send("2026-11-14T12:00:00Z"); // Saturday
      expect(lastReminder("dlwk@client.example").subject).toBe("REMINDER: Please sign: NDA – expires in 24 hours");
    });

    it("skip the 24-hour one when the document was sent with less time left", async () => {
      await deadline("dlshort@client.example", "2026-11-13T09:00:00.000Z", "2026-11-12T10:00:00.000Z");
      await send("2026-11-12T10:30:00Z");
      expect(reminders("dlshort@client.example")).toBe(0);
      await send("2026-11-13T08:00:00Z");
      expect(lastReminder("dlshort@client.example").subject).toBe("REMINDER: Please sign: NDA – expires in 1 hour");
    });

    it("send only the 1-hour one when an instance wakes up late", async () => {
      await deadline("dllate@client.example", "2026-11-13T17:00:00.000Z", "2026-11-11T10:00:00.000Z");
      await send("2026-11-13T16:30:00Z");
      await send("2026-11-13T16:45:00Z");
      expect(reminders("dllate@client.example")).toBe(1);
      expect(lastReminder("dllate@client.example").subject).toContain("expires in 1 hour");
    });
  });
});
