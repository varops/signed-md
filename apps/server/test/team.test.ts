import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/context.ts";
import { updateAccount } from "../src/services/accounts.ts";
import { apiKeyActor, createApiKey, listApiKeys } from "../src/services/auth.ts";
import { createDocument, getDocument, listDocuments, previewDocument, revokeDocument, sendDocument } from "../src/services/documents.ts";
import { approveTemplateVersion, createTemplate } from "../src/services/templates.ts";
import * as team from "../src/services/team.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

describe("teams and permissions", async () => {
  const { ctx, user: owner, dataDir } = await testContext();
  afterAll(() => ctx.close());

  /** Invite and accept, returning the new user's UI actor. */
  async function joinTeam(email: string, role: "admin" | "member" | "viewer", name: string): Promise<Actor & { kind: "user" }> {
    await team.inviteMember(ctx, owner, { email, role });
    await drainJobs(ctx);
    const dir = join(dataDir, "outbox");
    const mail = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string }).filter((m) => m.to === email).at(-1)!;
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    await team.acceptInvitation(ctx, token, { name, password: "long enough password" });
    const u = (await team.listMembers(ctx)).find((m) => m.email === email)!;
    return { kind: "user", id: u.id, accountId: owner.accountId, label: email, name, role };
  }

  const admin = await joinTeam("adam@x.example", "admin", "Adam Admin");
  const mia = await joinTeam("mia@x.example", "member", "Mia Member");
  const max = await joinTeam("max@x.example", "member", "Max Member");
  const vic = await joinTeam("vic@x.example", "viewer", "Vic Viewer");
  const inline = (signer: string) => ({ content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: `${signer}@client.example` }] });

  it("lets members see and act on only their own documents", async () => {
    const miaDoc = await createDocument(ctx, mia, inline("one"));
    expect(miaDoc.owner?.name).toBe("Mia Member");
    await expect(getDocument(ctx, max, miaDoc.id)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    await expect(sendDocument(ctx, max, miaDoc.id, { approved_revision: miaDoc.revision })).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    expect((await listDocuments(ctx, max)).data).toHaveLength(0);
    expect((await listDocuments(ctx, mia)).data.map((d) => d.id)).toEqual([miaDoc.id]);
    // Admins and viewers see everything; only admins (and the owner) can act.
    expect((await listDocuments(ctx, admin)).data.map((d) => d.id)).toContain(miaDoc.id);
    expect((await getDocument(ctx, vic, miaDoc.id)).id).toBe(miaDoc.id);
    await expect(sendDocument(ctx, vic, miaDoc.id, { approved_revision: miaDoc.revision })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(createDocument(ctx, vic, inline("two"))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const sent = await sendDocument(ctx, mia, miaDoc.id, { approved_revision: (await previewDocument(ctx, mia, miaDoc.id)).revision });
    expect(sent.status).toBe("sent");
    expect((await revokeDocument(ctx, admin, miaDoc.id)).status).toBe("revoked");
  });

  it("sends signing emails from the document's owner", async () => {
    const d = await createDocument(ctx, mia, inline("three"));
    await sendDocument(ctx, mia, d.id, { approved_revision: (await previewDocument(ctx, mia, d.id)).revision });
    await drainJobs(ctx);
    const dir = join(dataDir, "outbox");
    const mail = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; html: string }).find((m) => m.to === "three@client.example")!;
    expect(mail.html).toContain("Mia Member sent you a document to review and sign.");
    expect(mail.html).toContain("mia@x.example");
  });

  it("keeps template approval with owners", async () => {
    const t = await createTemplate(ctx, admin, { name: "Admin draft", source: "# T\n\n{{a.signature:signature}}", approve: true });
    expect(t.versions[0]!.approval_status).toBe("pending_approval"); // admins can't self-approve
    await expect(approveTemplateVersion(ctx, admin, t.id, 1)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(createTemplate(ctx, vic, { name: "x", source: "# x" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await approveTemplateVersion(ctx, owner, t.id, 1)).approved_version).toBe(1);
  });

  it("guards settings and team management", async () => {
    await expect(updateAccount(ctx, mia, { name: "Hijacked" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(team.inviteMember(ctx, mia, { email: "z@x.example", role: "member" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(team.inviteMember(ctx, admin, { email: "z@x.example", role: "owner" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(team.changeRole(ctx, admin, owner.id, "member")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(team.changeRole(ctx, owner, owner.id, "admin")).rejects.toMatchObject({ code: "INVALID_REQUEST" }); // last owner
    await expect(team.deactivateMember(ctx, owner, owner.id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await team.changeRole(ctx, admin, max.id, "viewer");
    expect((await team.listMembers(ctx)).find((m) => m.id === max.id)!.role).toBe("viewer");
  });

  it("ties API keys to people: their role, their documents, and their account status", async () => {
    const { key } = await createApiKey(ctx, mia, "Mia's agent");
    const keyActor = (await apiKeyActor(ctx, key, "api"))!;
    expect(keyActor).toMatchObject({ kind: "apikey", role: "member", userId: mia.id });
    expect((await listDocuments(ctx, keyActor)).data.every((d) => d.owner?.id === mia.id)).toBe(true);
    expect((await listApiKeys(ctx, mia)).map((k) => k.label)).toEqual(["Mia's agent"]);
    expect((await listApiKeys(ctx, admin)).some((k) => k.label === "Mia's agent")).toBe(true);
    expect(await listApiKeys(ctx, vic)).toHaveLength(0);
    // Deactivating Mia stops her key at once; her documents stay.
    await team.deactivateMember(ctx, admin, mia.id);
    expect(await apiKeyActor(ctx, key, "api")).toBeNull();
    expect((await listDocuments(ctx, admin, { q: "" })).data.some((d) => d.owner?.id === mia.id)).toBe(true);
    await team.reactivateMember(ctx, admin, mia.id);
    expect(await apiKeyActor(ctx, key, "api")).not.toBeNull();
  });

  it("rejects reused and duplicate invitations", async () => {
    await expect(team.inviteMember(ctx, owner, { email: "adam@x.example", role: "member" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(team.acceptInvitation(ctx, "not-a-real-token-but-long-enough", { name: "X", password: "long enough password" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
