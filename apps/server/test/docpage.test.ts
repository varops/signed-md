import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { updateAccount } from "../src/services/accounts.ts";
import { createSession, csrfToken } from "../src/services/auth.ts";
import { convertToInline, createDocument, getDocument, loadDocument, updateDocument } from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { createTemplate, getTemplate } from "../src/services/templates.ts";
import { TEMPLATE, testContext } from "./helpers.ts";

describe("document page", async () => {
  const { ctx, user, api } = await testContext();
  afterAll(() => ctx.close());
  const app = createApp(ctx);
  const token = await createSession(ctx, user.id);
  const cookie = `smd_session=${token}`;
  const post = (path: string, fields: Record<string, string>) =>
    app.request(path, { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: csrfToken(ctx, token), ...fields }) });
  const tpl = await createTemplate(ctx, user, { name: "Services", source: TEMPLATE, approve: true });
  const signers = [
    { key: "client", name: "Cleo", email: "cleo@client.example" },
    { key: "provider", name: "Pat", email: "pat@automaze.example" },
  ];

  it("shows a draft as pages beside a panel that edits it, and the old edit page redirects", async () => {
    const d = await createDocument(ctx, user, { template_id: tpl.id, signers });
    const html = await (await app.request(`/documents/${d.id}`, { headers: { cookie } })).text();
    expect(html).toContain('class="workspace"');
    expect(html).toContain("data-paginate");
    expect(html).toContain(`action="/documents/${d.id}/edit"`);
    expect(html).toContain('role="tab"');
    expect(html).toContain("Save draft");
    expect(html).toContain('commandfor="detach-dialog"');
    const old = await app.request(`/documents/${d.id}/edit`, { headers: { cookie } });
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/documents/${d.id}`);

    // Saving the panel without a folder field or text keeps both.
    const saved = await post(`/documents/${d.id}/edit`, { title: "Renamed", "v:client_name": "Cleo Ltd", ...signerFields() });
    expect(saved.status).toBe(302);
    const after = await getDocument(ctx, user, d.id);
    expect(after.title).toBe("Renamed");
    expect(after.values.client_name).toBe("Cleo Ltd");
    expect((await loadDocument(ctx.db, d.id)).source).toBe(TEMPLATE);
  });

  it("turns a template draft into an inline draft before its text can change, and records it", async () => {
    const d = await createDocument(ctx, user, { template_id: tpl.id, signers });
    // The text route refuses template drafts.
    const refused = await post(`/documents/${d.id}/text`, { content: "# Changed" });
    expect(await refused.text()).toContain("Template documents follow their template");
    // People only, in the web UI.
    await expect(convertToInline(ctx, api, d.id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const res = await post(`/documents/${d.id}/to-inline`, {});
    expect(res.headers.get("location")).toBe(`/documents/${d.id}?edit=text`);
    const after = await getDocument(ctx, user, d.id);
    expect(after.source).toBe("inline");
    expect(after.template?.id).toBe(tpl.id); // still shows where it started
    expect((await listEvents(ctx.db, d.id)).map((e) => e.type)).toContain("document.converted_to_inline");
    const editor = await (await app.request(`/documents/${d.id}?edit=text`, { headers: { cookie } })).text();
    expect(editor).toContain(`action="/documents/${d.id}/text"`);

    const text = await post(`/documents/${d.id}/text`, { content: TEMPLATE.replace("# Service agreement", "# Service agreement (edited)") });
    expect(text.status).toBe(302);
    expect((await loadDocument(ctx.db, d.id)).source).toContain("(edited)");
    expect((await getDocument(ctx, user, d.id)).signers).toHaveLength(2); // text saves leave signers alone
  });

  it("doesn't offer or allow it when inline documents are turned off", async () => {
    const d = await createDocument(ctx, user, { template_id: tpl.id, signers });
    await updateAccount(ctx, user, { config: { inline_documents: "disabled" } });
    try {
      const html = await (await app.request(`/documents/${d.id}`, { headers: { cookie } })).text();
      expect(html).not.toContain('commandfor="detach-dialog"');
      await expect(convertToInline(ctx, user, d.id)).rejects.toMatchObject({ code: "INLINE_DISABLED" });
    } finally {
      await updateAccount(ctx, user, { config: { inline_documents: "allowed" } });
    }
  });
});

describe("agent skill", async () => {
  const { ctx } = await testContext();
  afterAll(() => ctx.close());
  it("is served as Markdown without logging in, for agents to install", async () => {
    const res = await createApp(ctx).request("/skill.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("name: signed-md");
  });
});

describe("signing order 0", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());

  it("is for every signer or none: a mix of 0 and numbers is refused", async () => {
    const t = await createTemplate(ctx, user, { name: "Services", source: TEMPLATE, approve: true });
    const signer = (key: string, order: number) => ({ key, name: key, email: `${key}@x.example`, order });
    await expect(createDocument(ctx, user, { template_id: t.id, signers: [signer("client", 2), signer("provider", 0)] })).rejects.toMatchObject({ code: "SIGNER_INVALID" });
    const d = await createDocument(ctx, user, { template_id: t.id, signers: [signer("client", 0), signer("provider", 0)] });
    expect(d.signers.map((s) => s.order)).toEqual([0, 0]);
    await expect(updateDocument(ctx, user, d.id, { signers: [signer("client", 1)] })).rejects.toMatchObject({ code: "SIGNER_INVALID" });
    const both = await updateDocument(ctx, user, d.id, { signers: [signer("client", 1), signer("provider", 2)] });
    expect(both.signers.map((s) => s.order)).toEqual([1, 2]);
  });
});

describe("template versions", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());

  it("show the name read-only and never rename the template", async () => {
    const app = createApp(ctx);
    const token = await createSession(ctx, user.id);
    const cookie = `smd_session=${token}`;
    const t = await createTemplate(ctx, user, { name: "Services", source: TEMPLATE, approve: true });
    const form = await (await app.request(`/templates/${t.id}/edit`, { headers: { cookie } })).text();
    expect(form).toContain("<h1>Services</h1>");
    expect(form).not.toContain('name="name"');
    const res = await app.request(`/templates/${t.id}/edit`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: csrfToken(ctx, token), name: "Renamed", description: "", source: TEMPLATE, approve: "1" }) });
    expect(res.status).toBe(302);
    const after = await getTemplate(ctx, t.id);
    expect(after.name).toBe("Services");
    expect(after.current_version).toBe(2);
  });
});

function signerFields(): Record<string, string> {
  return {
    "signers[0][key]": "client", "signers[0][name]": "Cleo", "signers[0][email]": "cleo@client.example", "signers[0][order]": "1",
    "signers[1][key]": "provider", "signers[1][name]": "Pat", "signers[1][email]": "pat@automaze.example", "signers[1][order]": "2",
  };
}
