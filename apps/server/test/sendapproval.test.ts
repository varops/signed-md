import { describe, expect, it } from "vitest";
import { getAccount, updateAccount } from "../src/services/accounts.ts";
import {
  approveInlineDocument,
  approveSending,
  createDocument,
  getDocument,
  previewDocument,
  sendDocument,
  updateDocument,
  validateDocument,
} from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { testContext } from "./helpers.ts";

const NDA = { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "a@client.example" }] };

async function setup() {
  const t = await testContext();
  await updateAccount(t.ctx, t.user, { config: { agent_sends: "needs_approval" } });
  return t;
}

describe("sending by agents needs approval in the UI", () => {
  it("is off by default: an agent sends the previewed revision", async () => {
    const { ctx, api } = await testContext();
    expect((await getAccount(ctx)).config.agent_sends).toBe("allowed");
    const d = await createDocument(ctx, api, NDA);
    expect(d.send_approval).toBeNull();
    const sent = await sendDocument(ctx, api, d.id, { approved_revision: (await previewDocument(ctx, api, d.id)).revision });
    expect(sent.status).toBe("sent");
    await ctx.close();
  });

  it("blocks an agent until a person approves the exact revision", async () => {
    const { ctx, user, api } = await setup();
    const d = await createDocument(ctx, api, NDA);
    expect(d.send_approval).toEqual({ required: true, approved: false, approved_at: null });
    expect((await validateDocument(ctx, api, d.id)).warnings.map((w) => w.code)).toContain("DOCUMENT_NOT_APPROVED");
    const rev = (await previewDocument(ctx, api, d.id)).revision;
    await expect(sendDocument(ctx, api, d.id, { approved_revision: rev, approved_by: "Ran, in chat" })).rejects.toMatchObject({
      code: "DOCUMENT_NOT_APPROVED",
      message: expect.stringContaining(`/documents/${d.id}`),
    });

    // Agents can't approve, or turn the setting off.
    await expect(approveSending(ctx, api, d.id, rev)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(updateAccount(ctx, api, { config: { agent_sends: "allowed" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(updateAccount(ctx, api, { config: { inline_documents: "allowed" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const approved = await approveSending(ctx, user, d.id, rev);
    expect(approved.send_approval).toMatchObject({ required: true, approved: true });
    expect((await validateDocument(ctx, api, d.id)).warnings).toEqual(expect.not.arrayContaining([expect.objectContaining({ code: "DOCUMENT_NOT_APPROVED" })]));
    expect((await sendDocument(ctx, api, d.id, { approved_revision: rev })).status).toBe("sent");
    expect((await getDocument(ctx, api, d.id)).send_approval).toBeNull();
    const types = (await listEvents(ctx.db, d.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["document.send_approved", "document.approved", "document.sent"]));
    await ctx.close();
  });

  it("needs a new approval after an edit", async () => {
    const { ctx, user, api } = await setup();
    const d = await createDocument(ctx, api, NDA);
    await approveSending(ctx, user, d.id, (await previewDocument(ctx, api, d.id)).revision);
    await updateDocument(ctx, api, d.id, { content: "# NDA v2\n\n{{a.signature:signature}}" });
    const rev = (await previewDocument(ctx, api, d.id)).revision;
    expect((await getDocument(ctx, api, d.id)).send_approval?.approved).toBe(false);
    await expect(sendDocument(ctx, api, d.id, { approved_revision: rev })).rejects.toMatchObject({ code: "DOCUMENT_NOT_APPROVED" });
    await expect(approveSending(ctx, user, d.id, "rev_old")).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    await ctx.close();
  });

  it("keeps auto_send as a draft", async () => {
    const { ctx, api } = await setup();
    await expect(createDocument(ctx, api, { ...NDA, auto_send: true })).rejects.toMatchObject({ code: "DOCUMENT_NOT_APPROVED" });
    const drafts = await ctx.db.selectFrom("documents").select("status").execute();
    expect(drafts.map((x) => x.status)).toEqual(["draft"]);
    await ctx.close();
  });

  it("lets a person send from the web UI without a separate approval", async () => {
    const { ctx, user, api } = await setup();
    const d = await createDocument(ctx, api, NDA);
    expect((await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision })).status).toBe("sent");
    await ctx.close();
  });

  it("counts an inline approval as a send approval", async () => {
    const { ctx, user, api } = await setup();
    await updateAccount(ctx, user, { config: { inline_documents: "needs_approval" } });
    const d = await createDocument(ctx, api, NDA);
    const rev = (await previewDocument(ctx, api, d.id)).revision;
    await approveInlineDocument(ctx, user, d.id, rev);
    expect((await sendDocument(ctx, api, d.id, { approved_revision: rev })).status).toBe("sent");
    await ctx.close();
  });
});
