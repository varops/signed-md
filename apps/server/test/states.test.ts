import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deliveryMachine,
  documentMachine,
  invitationMachine,
  invitationStatus,
  isOpenStatus,
  signerMachine,
  templateVersionMachine,
  transition,
  userMachine,
} from "@signed-md/core";
import { newId, now } from "@signed-md/db";
import { afterAll, describe, expect, it } from "vitest";
import { createDocument, getDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { declineDocument, recordConsent } from "../src/services/signing.ts";
import * as team from "../src/services/team.ts";
import { markWebhookFailed } from "../src/services/webhooks.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const meta = { ip: "203.0.113.7", user_agent: "vitest" };

function lastLink(dataDir: string, email: string, path: "s" | "invite"): string {
  const dir = join(dataDir, "outbox");
  const mails = readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string });
  return new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(mails.filter((m) => m.to === email).at(-1)!.text)![1]!;
}

describe("state machines", () => {
  it("allow only the listed transitions", () => {
    expect(documentMachine.sources("sign").sort()).toEqual(["partially_signed", "sent"]);
    expect(isOpenStatus("sent") && isOpenStatus("partially_signed")).toBe(true);
    expect(isOpenStatus("draft") || isOpenStatus("signed")).toBe(false);
    expect(() => transition("finalized", "revoke")).toThrow(expect.objectContaining({ code: "DOCUMENT_NOT_REVOCABLE" }));
    expect(() => transition("sent", "send")).toThrow(expect.objectContaining({ code: "DOCUMENT_ALREADY_SENT" }));
    expect(() => transition("draft", "finalize")).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));

    // A resend keeps a signer where they are; a pending signer can't sign or decline.
    expect(signerMachine.next("pending", "notify")).toBe("notified");
    expect(signerMachine.next("viewed", "notify")).toBe("viewed");
    expect(signerMachine.can("pending", "sign") || signerMachine.can("pending", "decline")).toBe(false);
    expect(signerMachine.can("signed", "decline") || signerMachine.can("declined", "sign")).toBe(false);

    expect(templateVersionMachine.can("approved", "approve")).toBe(false);
    expect(userMachine.next("active", "deactivate")).toBe("disabled");
    expect(deliveryMachine.can("delivered", "give_up") || deliveryMachine.can("failed", "deliver")).toBe(false);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: future })).toBe("pending");
    expect(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: "2000-01-01T00:00:00.000Z" })).toBe("expired");
    expect(invitationStatus({ accepted_at: now(), revoked_at: now(), expires_at: future })).toBe("accepted");
    expect(invitationMachine.can("expired", "accept") || invitationMachine.can("accepted", "revoke")).toBe(false);
  });
});

describe("guarded state changes", async () => {
  const { ctx, user, dataDir } = await testContext();
  afterAll(() => ctx.close());

  it("won't accept an invitation that was revoked or expired after the link was sent", async () => {
    await team.inviteMember(ctx, user, { email: "rev@x.example", role: "member" });
    await drainJobs(ctx);
    const token = lastLink(dataDir, "rev@x.example", "invite");
    const [inv] = await team.listInvitations(ctx);
    await team.revokeInvitation(ctx, user, inv!.id);
    await expect(team.acceptInvitation(ctx, token, { name: "Rev", password: "long enough password" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await team.inviteMember(ctx, user, { email: "late@x.example", role: "member" });
    await drainJobs(ctx);
    const late = lastLink(dataDir, "late@x.example", "invite");
    await ctx.db.updateTable("invitations").set({ expires_at: "2000-01-01T00:00:00.000Z" }).where("email", "=", "late@x.example").execute();
    await expect(team.acceptInvitation(ctx, late, { name: "Late", password: "long enough password" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await team.listMembers(ctx)).map((m) => m.email)).not.toContain("late@x.example");
  });

  it("logs a deactivation once, however often it's asked for", async () => {
    await team.inviteMember(ctx, user, { email: "dee@x.example", role: "member" });
    await drainJobs(ctx);
    await team.acceptInvitation(ctx, lastLink(dataDir, "dee@x.example", "invite"), { name: "Dee", password: "long enough password" });
    const dee = (await team.listMembers(ctx)).find((m) => m.email === "dee@x.example")!;
    await team.deactivateMember(ctx, user, dee.id);
    await team.deactivateMember(ctx, user, dee.id);
    const logged = await ctx.db.selectFrom("audit_events").select("id").where("type", "=", "team.deactivated").execute();
    expect(logged).toHaveLength(1);
  });

  it("treats a document past its deadline as closed for declines too", async () => {
    const doc = await createDocument(ctx, user, { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "a@client.example" }] });
    await sendDocument(ctx, user, doc.id, { approved_revision: (await previewDocument(ctx, user, doc.id)).revision });
    await drainJobs(ctx);
    const token = lastLink(dataDir, "a@client.example", "s");
    await ctx.db.updateTable("documents").set({ expires_at: "2000-01-01T00:00:00.000Z" }).where("id", "=", doc.id).execute();
    await expect(declineDocument(ctx, token, "no", meta)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(recordConsent(ctx, token, meta)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await getDocument(ctx, user, doc.id)).status).toBe("sent");
  });

  it("never marks a delivered webhook as failed", async () => {
    const id = newId("whd");
    await ctx.db
      .insertInto("webhook_deliveries")
      .values({ id, event_id: newId("evt"), event_type: "document.signed", document_id: null, url: "http://127.0.0.1:9/hook", body: "{}", status: "delivered", attempts: 1, last_status_code: 200, last_error: null, created_at: now(), delivered_at: now() })
      .execute();
    await markWebhookFailed(ctx, id);
    const row = await ctx.db.selectFrom("webhook_deliveries").select("status").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.status).toBe("delivered");
  });
});
