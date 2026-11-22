import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enqueueJob } from "@signed-md/db";
import { describe, expect, it } from "vitest";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { NEXT_WORK_FILE, nextWorkAt, writeNextWorkAt } from "../src/services/schedule.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const at = (iso: string) => new Date(iso);

async function withSentDocument(opts: { notified: string; expires?: string; reminders?: boolean }) {
  const t = await testContext();
  const doc = await createDocument(t.ctx, t.user, {
    content: "# NDA\n\n{{a.signature:signature}}",
    signers: [{ key: "a", name: "A", email: "a@client.example" }],
    ...(opts.reminders === false ? { reminders: false } : {}),
  });
  await sendDocument(t.ctx, t.user, doc.id, { approved_revision: (await previewDocument(t.ctx, t.user, doc.id)).revision });
  await drainJobs(t.ctx);
  await t.ctx.db.updateTable("signers").set({ notified_at: opts.notified }).where("document_id", "=", doc.id).execute();
  await t.ctx.db
    .updateTable("documents")
    .set({ expires_at: opts.expires ?? "2027-06-01T00:00:00.000Z" })
    .where("id", "=", doc.id)
    .execute();
  return { ...t, doc };
}

describe("next work time", () => {
  it("is empty when nothing is planned", async () => {
    const { ctx } = await testContext();
    await drainJobs(ctx);
    expect(await nextWorkAt(ctx, at("2026-11-03T10:00:00Z"))).toBeNull();
    await ctx.close();
  });

  it("is now when a job is due, and the job's time when it waits", async () => {
    const { ctx } = await testContext();
    await drainJobs(ctx);
    await enqueueJob(ctx.db, "email", { kind: "test" }, { runAt: at("2026-11-03T12:00:00Z") });
    expect((await nextWorkAt(ctx, at("2026-11-03T10:00:00Z")))!.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect((await nextWorkAt(ctx, at("2026-11-03T13:00:00Z")))!.toISOString()).toBe("2026-11-03T13:00:00.000Z");
    await ctx.close();
  });

  it("is the next regular reminder, 3 business days after the last email", async () => {
    const { ctx } = await withSentDocument({ notified: "2026-11-04T10:00:00.000Z" }); // Wednesday
    expect((await nextWorkAt(ctx, at("2026-11-05T10:00:00Z")))!.toISOString()).toBe("2026-11-09T10:00:00.000Z"); // Monday
    await ctx.close();
  });

  it("moves an overdue regular reminder to the next business day", async () => {
    const { ctx } = await withSentDocument({ notified: "2026-11-02T10:00:00.000Z" }); // due Thursday 5 November
    // Saturday: it waits for Monday, as sendReminders does.
    expect((await nextWorkAt(ctx, at("2026-11-07T12:00:00Z")))!.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    await ctx.close();
  });

  it("is the 24-hour reminder when the deadline is less than 4 days away", async () => {
    const { ctx } = await withSentDocument({ notified: "2026-11-12T10:00:00.000Z", expires: "2026-11-16T17:00:00.000Z" });
    expect((await nextWorkAt(ctx, at("2026-11-13T10:00:00Z")))!.toISOString()).toBe("2026-11-15T17:00:00.000Z");
    // After the 24-hour reminder, the 1-hour one.
    await ctx.db.updateTable("signers").set({ deadline_reminders: 1, last_reminded_at: "2026-11-15T17:00:00.000Z" }).execute();
    expect((await nextWorkAt(ctx, at("2026-11-15T17:01:00Z")))!.toISOString()).toBe("2026-11-16T16:00:00.000Z");
    // After both, only the expiry is left.
    await ctx.db.updateTable("signers").set({ deadline_reminders: 2, last_reminded_at: "2026-11-16T16:00:00.000Z" }).execute();
    expect((await nextWorkAt(ctx, at("2026-11-16T16:01:00Z")))!.toISOString()).toBe("2026-11-16T17:00:00.000Z");
    await ctx.close();
  });

  it("is only the expiry when reminders are off", async () => {
    const { ctx } = await withSentDocument({ notified: "2026-11-02T10:00:00.000Z", expires: "2026-12-01T09:00:00.000Z", reminders: false });
    expect((await nextWorkAt(ctx, at("2026-11-03T10:00:00Z")))!.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    await ctx.close();
  });

  it("is written to DATA_DIR, and left empty for a disabled account", async () => {
    const { ctx, dataDir } = await withSentDocument({ notified: "2026-11-02T10:00:00.000Z" });
    await writeNextWorkAt(ctx);
    expect(readFileSync(join(dataDir, NEXT_WORK_FILE), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
    await ctx.close();

    const off = await testContext({ ACTIVE: "false" });
    await enqueueJob(off.ctx.db, "email", { kind: "test" });
    await writeNextWorkAt(off.ctx);
    expect(readFileSync(join(off.dataDir, NEXT_WORK_FILE), "utf8")).toBe("");
    await off.ctx.close();
  });
});
