import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyPackageFiles } from "@signed-md/core";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { getAccount, updateAccount } from "../src/services/accounts.ts";
import { createDocument, previewDocument, revokeDocument, sendDocument, updateDocument } from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { listArtifacts, readArtifact } from "../src/services/finalize.ts";
import { declineDocument, openSigningPage, submitSignature } from "../src/services/signing.ts";
import { approveTemplateVersion, createTemplate } from "../src/services/templates.ts";
import { drainJobs } from "../src/worker.ts";
import { TEMPLATE, testContext } from "./helpers.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const meta = { ip: "203.0.113.7", user_agent: "vitest" };

function outbox(dataDir: string) {
  const dir = join(dataDir, "outbox");
  return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; subject: string; text: string; attachments: { filename: string }[] });
}
function linkFor(dataDir: string, email: string): string {
  const m = outbox(dataDir).filter((e) => e.to === email).at(-1)!;
  return /\/s\/([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
}

describe("end-to-end signing flow (services)", async () => {
  const { ctx, user, api, dataDir } = await testContext();
  afterAll(() => ctx.close());

  it("blocks unapproved templates, then runs to a verified package", async () => {
    const tpl = await createTemplate(ctx, api, { name: "Services", source: TEMPLATE });
    expect(tpl.versions[0]!.approval_status).toBe("pending_approval");
    const input = {
      template_id: tpl.id,
      values: { client_name: "Acme Ltd", fee: "1000", notice_days: 30 },
      signers: [
        { key: "client", name: "Jane Doe", email: "jane@acme.example", order: 1 },
        { key: "provider", name: "Sam Lee", email: "sam@automaze.example", order: 2 },
      ],
      metadata: { customer_id: "acme" },
    };
    await expect(createDocument(ctx, api, input)).rejects.toMatchObject({ code: "TEMPLATE_NOT_APPROVED" });
    await expect(approveTemplateVersion(ctx, api, tpl.id, 1)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await approveTemplateVersion(ctx, user, tpl.id, 1);

    const doc = await createDocument(ctx, api, input);
    expect(doc.status).toBe("draft");
    expect(doc.validation?.valid).toBe(true);

    // Edit invalidates the old revision.
    const p1 = await previewDocument(ctx, doc.id);
    expect(p1.html).toContain("$1,000.00");
    await updateDocument(ctx, api, doc.id, { values: { fee: "1200.00" } });
    await expect(sendDocument(ctx, api, doc.id, { approved_revision: p1.revision })).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    const p2 = await previewDocument(ctx, doc.id);
    const sent = await sendDocument(ctx, api, doc.id, { approved_revision: p2.revision, approved_by: "Ran, via chat" });
    expect(sent.status).toBe("sent");
    expect(sent.current_signing_group).toBe(1);
    await drainJobs(ctx);
    expect(outbox(dataDir).map((m) => m.to)).toEqual(["jane@acme.example"]); // provider waits for order 2

    // Client signs.
    const clientToken = linkFor(dataDir, "jane@acme.example");
    const page = await openSigningPage(ctx, clientToken, meta);
    expect(page.state).toBe("sign");
    if (page.state === "sign") expect(page.view.fields.map((f) => f.key)).toEqual(["client.start_date", "client.signature"]);
    await expect(submitSignature(ctx, clientToken, { consent: false, fields: {} }, meta)).rejects.toMatchObject({ code: "FIELD_REQUIRED" });
    await expect(submitSignature(ctx, clientToken, { consent: true, fields: { "client.start_date": "2026-13-01" } }, meta)).rejects.toMatchObject({ code: "FIELD_INVALID" });
    const r1 = await submitSignature(ctx, clientToken, { consent: true, fields: { "client.start_date": "2026-12-01", "client.signature": { kind: "drawn", image: PNG } } }, meta);
    expect(r1.document_status).toBe("partially_signed");
    await drainJobs(ctx);

    // Provider is notified now, and signs with a typed signature.
    const providerToken = linkFor(dataDir, "sam@automaze.example");
    const r2 = await submitSignature(ctx, providerToken, { consent: true, fields: { "provider.signature": { kind: "typed", text: "Sam Lee" } } }, meta);
    expect(r2.document_status).toBe("signed");
    await drainJobs(ctx);

    const arts = await listArtifacts(ctx, doc.id);
    expect(arts.map((a) => a.type)).toEqual(["pdf", "zip"]);
    const zip = await readArtifact(ctx, arts.find((a) => a.type === "zip")!.id);
    const files = unzipSync(new Uint8Array(zip!.data));
    expect(Object.keys(files).sort()).toEqual(["agreement.json", "agreement.md", "evidence.json", "manifest.json", "manifest.sig", "public-key.json", "signatures.json", "signed.pdf"]);
    const report = verifyPackageFiles(files, { trustedKeys: [ctx.keys.info.public_key] });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.signers.map((s) => s.key)).toEqual(["client", "provider"]);

    // Tampering is detected.
    const tampered = { ...files, "agreement.md": Buffer.from(Buffer.from(files["agreement.md"]!).toString().replace("1,200.00", "12.00")) };
    expect(verifyPackageFiles(tampered).ok).toBe(false);

    // Completion emails carry the PDF, to every signer and the sender.
    const completed = outbox(dataDir).filter((m) => m.subject.startsWith("Completed"));
    expect(completed.map((m) => m.to).sort()).toEqual(["admin@automaze.example", "jane@acme.example", "sam@automaze.example"]);
    expect(completed[0]!.attachments[0]!.filename).toMatch(/\.pdf$/);

    const types = (await listEvents(ctx.db, doc.id)).map((e) => e.type);
    expect(types).toContain("document.finalized");
  }, 60_000);

  it("revokes and declines", async () => {
    const d1 = await createDocument(ctx, user, {
      content: "# NDA\n\nSigned: {{a.signature:signature}}",
      signers: [{ key: "a", name: "A", email: "a@x.example" }],
    });
    const p = await previewDocument(ctx, d1.id);
    await sendDocument(ctx, user, d1.id, { approved_revision: p.revision });
    await drainJobs(ctx);
    const tok = linkFor(dataDir, "a@x.example");
    const revoked = await revokeDocument(ctx, user, d1.id, "Wrong email");
    expect(revoked.status).toBe("revoked");
    expect((await openSigningPage(ctx, tok, meta)).state).toBe("invalid"); // token invalidated
    await expect(revokeDocument(ctx, user, d1.id)).rejects.toMatchObject({ code: "DOCUMENT_NOT_REVOCABLE" });

    const d2 = await createDocument(ctx, user, {
      content: "# NDA 2\n\nSigned: {{b.signature:signature}}",
      signers: [{ key: "b", name: "B", email: "b@x.example" }],
    });
    await sendDocument(ctx, user, d2.id, { approved_revision: (await previewDocument(ctx, d2.id)).revision });
    await drainJobs(ctx);
    await declineDocument(ctx, linkFor(dataDir, "b@x.example"), "Price too high", meta);
    await drainJobs(ctx);
    expect(outbox(dataDir).some((m) => /declined/i.test(m.subject) && m.text.includes("Price too high"))).toBe(true);
  });

  it("enforces the inline document setting", async () => {
    await updateAccount(ctx, { config: { inline_documents: "needs_approval" } });
    const d = await createDocument(ctx, api, { content: "# X\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "a@y.example" }] });
    const rev = (await previewDocument(ctx, d.id)).revision;
    await expect(sendDocument(ctx, api, d.id, { approved_revision: rev })).rejects.toMatchObject({ code: "DOCUMENT_NOT_APPROVED" });
    await updateAccount(ctx, { config: { inline_documents: "disabled" } });
    await expect(createDocument(ctx, api, { content: "# Y", signers: [] })).rejects.toMatchObject({ code: "INLINE_DISABLED" });
    await updateAccount(ctx, { config: { inline_documents: "allowed" } });
    expect((await getAccount(ctx)).config.inline_documents).toBe("allowed");
  });
});

describe("branding", async () => {
  const { ctx, user, dataDir } = await testContext();
  afterAll(() => ctx.close());
  const { setDefaultMessage, setLogo, readLogo } = await import("../src/services/branding.ts");

  it("accepts only small PNG or JPEG logos", async () => {
    await expect(setLogo(ctx, new TextEncoder().encode("<svg onload=alert(1)>"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(setLogo(ctx, new Uint8Array(400_000).fill(0x89))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await setLogo(ctx, Buffer.from(PNG.split(",")[1]!, "base64"));
    expect((await readLogo(ctx))?.contentType).toBe("image/png");
  });

  it("uses the default message, or the one given when sending, in an HTML email with the logo inline", async () => {
    await setDefaultMessage(ctx, "Default hello & welcome");
    const d = await createDocument(ctx, user, { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "a@brand.example" }] });
    await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, d.id)).revision });
    const d2 = await createDocument(ctx, user, { content: "# NDA 2\n\n{{b.signature:signature}}", signers: [{ key: "b", name: "B", email: "b@brand.example" }] });
    await sendDocument(ctx, user, d2.id, { approved_revision: (await previewDocument(ctx, d2.id)).revision, message: "Custom <b>note</b>" });
    await drainJobs(ctx);
    const dir = join(dataDir, "outbox");
    const mails = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; html: string });
    const a = mails.find((m) => m.to === "a@brand.example")!;
    const b = mails.find((m) => m.to === "b@brand.example")!;
    expect(a.html).toContain("Default hello &amp; welcome");
    expect(a.html).toContain("data:image/png;base64,"); // logo inlined
    expect(b.html).toContain("Custom &lt;b&gt;note&lt;/b&gt;"); // escaped
    expect(b.html).not.toContain("Default hello");
  });
});
