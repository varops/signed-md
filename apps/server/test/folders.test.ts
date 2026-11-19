import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createApiKey, createSession, csrfToken } from "../src/services/auth.ts";
import { createDocument, getDocument, listDocuments, moveDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { createFolder, deleteFolder, folderCounts, listFolders, renameFolder } from "../src/services/folders.ts";
import { createTemplate, listTemplates, moveTemplate } from "../src/services/templates.ts";
import { TEMPLATE, testContext } from "./helpers.ts";

const inline = (n: number) => ({ content: `# NDA ${n}\n\n{{a.signature:signature}}`, signers: [{ key: "a", name: "Ann", email: `ann${n}@client.example` }] });

describe("folders", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());

  it("files documents and templates, filters lists, and keeps the kinds apart", async () => {
    const clients = await createFolder(ctx, user, "document", "  Clients  ");
    expect(clients.name).toBe("Clients");
    const legal = await createFolder(ctx, user, "template", "Legal");
    await expect(createFolder(ctx, user, "document", "clients")).rejects.toThrow(/already a document folder/);
    expect((await createFolder(ctx, user, "template", "Clients")).kind).toBe("template"); // separate lists

    const a = await createDocument(ctx, user, { ...inline(1), folder_id: clients.id });
    const b = await createDocument(ctx, user, inline(2));
    expect(a.folder).toEqual({ id: clients.id, name: "Clients" });
    expect((await listDocuments(ctx, user, { folder: clients.id })).data.map((d) => d.id)).toEqual([a.id]);
    expect((await listDocuments(ctx, user, { folder: "none" })).data.map((d) => d.id)).toEqual([b.id]);
    await expect(createDocument(ctx, user, { ...inline(3), folder_id: legal.id })).rejects.toThrow(/holds templates/);

    const t = await createTemplate(ctx, user, { name: "Services", source: TEMPLATE, folder_id: legal.id });
    expect(t.folder?.name).toBe("Legal");
    expect((await listTemplates(ctx, { folder: "none" })).map((x) => x.id)).not.toContain(t.id);
    expect((await moveTemplate(ctx, user, t.id, null)).folder).toBeNull();
  });

  it("moves documents in any status without changing the revision", async () => {
    const f = await createFolder(ctx, user, "document", "Signed deals");
    const d = await createDocument(ctx, user, inline(4));
    const sent = await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision });
    const moved = await moveDocument(ctx, user, d.id, f.id);
    expect(moved.folder?.id).toBe(f.id);
    expect(moved.revision).toBe(sent.revision);
    expect(moved.status).toBe("sent");
  });

  it("renames, counts, and deletes folders by moving what is in them to the top level", async () => {
    const f = await createFolder(ctx, user, "document", "Old");
    const d = await createDocument(ctx, user, { ...inline(5), folder_id: f.id });
    expect((await folderCounts(ctx, "document")).get(f.id)).toBe(1);
    expect((await renameFolder(ctx, user, f.id, "Older")).name).toBe("Older");
    expect((await deleteFolder(ctx, user, f.id)).moved).toBe(1);
    expect((await listFolders(ctx, "document")).map((x) => x.id)).not.toContain(f.id);
    expect((await getDocument(ctx, user, d.id)).folder).toBeNull();
    await expect(moveDocument(ctx, user, d.id, f.id)).rejects.toThrow(/does not exist/);
    expect((await createFolder(ctx, user, "document", "Older")).name).toBe("Older"); // the name is free again
    // The row is kept, marked, not removed.
    expect(await ctx.db.selectFrom("folders").select("archived_at").where("id", "=", f.id).executeTakeFirst()).toMatchObject({ archived_at: expect.any(String) });
  });

  it("works over the API and in the web UI", async () => {
    const app = createApp(ctx);
    const key = (await createApiKey(ctx, user, "agent")).key;
    const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const created = await app.request("/v1/folders", { method: "POST", headers: auth, body: JSON.stringify({ kind: "document", name: "From API" }) });
    expect(created.status).toBe(201);
    const folder = (await created.json()) as { id: string };
    const doc = await app.request("/v1/documents", { method: "POST", headers: auth, body: JSON.stringify({ ...inline(6), folder_id: folder.id }) });
    expect(((await doc.json()) as { folder: { id: string } }).folder.id).toBe(folder.id);
    const listed = (await (await app.request(`/v1/documents?folder_id=${folder.id}`, { headers: auth })).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);

    const token = await createSession(ctx, user.id);
    const page = await (await app.request("/documents", { headers: { cookie: `smd_session=${token}` } })).text();
    expect(page).toContain('class="folder-card"');
    expect(page).toContain("From API");
    expect(page).toContain(`commandfor="delete-${folder.id}"`);
    // The top level lists everything, including what is in folders.
    expect(page).toContain(`/documents/${(listed.data[0] as { id: string }).id}`);
    const inside = await (await app.request(`/documents?folder=${folder.id}`, { headers: { cookie: `smd_session=${token}` } })).text();
    expect(inside).toContain('aria-label="Breadcrumb"');
    expect(inside).toContain(`/documents/new?folder=${folder.id}`);
    // The Folder column moves a document from the list and comes back to it, never to another site.
    const docId = (listed.data[0] as { id: string }).id;
    expect(page).toContain(`action="/documents/${docId}/move"`);
    const form = (folderId: string, back: string) => ({ method: "POST", headers: { cookie: `smd_session=${token}` }, body: new URLSearchParams({ _csrf: csrfToken(ctx, token), kind: "document", folder_id: folderId, back }) });
    const moved = await app.request(`/documents/${docId}/move`, form("", "/documents?mine=1"));
    expect(moved.headers.get("location")).toBe("/documents?mine=1");
    expect((await app.request(`/documents/${docId}/move`, form(folder.id, "//evil.example"))).headers.get("location")).toBe(`/documents/${docId}?msg=saved`);
    const del = await app.request(`/v1/folders/${folder.id}`, { method: "DELETE", headers: auth });
    expect(((await del.json()) as { moved: number }).moved).toBe(1);
    const res = await app.request("/folders", { method: "POST", headers: { cookie: `smd_session=${token}` }, body: new URLSearchParams({ _csrf: csrfToken(ctx, token), kind: "template", name: "Sales" }) });
    expect(res.status).toBe(302);
    expect((await listFolders(ctx, "template")).map((f) => f.name)).toContain("Sales");
  });
});
