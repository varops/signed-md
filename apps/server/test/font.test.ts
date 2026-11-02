import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { setContractFont } from "../src/services/branding.ts";
import { createDocument, previewDocument, sendDocument, updateDocument } from "../src/services/documents.ts";
import { listArtifacts, readArtifact } from "../src/services/finalize.ts";
import { recordConsent, submitSignature } from "../src/services/signing.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("contract font", async () => {
  const { ctx, user, dataDir } = await testContext();
  afterAll(() => ctx.close());
  let n = 0;
  const doc = (font?: string) =>
    createDocument(ctx, user, { content: "# Agreement\n\nSigned: {{a.signature:signature}}", signers: [{ key: "a", name: "A", email: `font${++n}@x.example` }], ...(font ? { font } : {}) });

  async function pdfFonts(id: string, email: string): Promise<string> {
    await sendDocument(ctx, user, id, { approved_revision: (await previewDocument(ctx, user, id)).revision });
    await drainJobs(ctx);
    const dir = join(dataDir, "outbox");
    const mail = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string }).find((m) => m.to === email)!;
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const meta = { ip: null, user_agent: null };
    await recordConsent(ctx, token, meta);
    await submitSignature(ctx, token, { consent: false, fields: { "a.signature": { kind: "drawn", image: PNG } } }, meta);
    await drainJobs(ctx);
    const zip = (await listArtifacts(ctx, user, id)).find((a) => a.type === "zip")!;
    const pdf = unzipSync(new Uint8Array((await readArtifact(ctx, zip.id))!.data))["signed.pdf"]!;
    return Buffer.from(pdf).toString("latin1");
  }

  it("uses the account default, which documents can override, and freezes it per document", async () => {
    expect((await doc()).font).toBe("serif");
    await setContractFont(ctx, user, "sans-serif");
    const d = await doc();
    expect(d.font).toBe("sans-serif");
    expect((await doc("serif")).font).toBe("serif");
    await setContractFont(ctx, user, "serif");
    expect((await previewDocument(ctx, user, d.id)).font).toBe("sans-serif"); // saved on the document
  });

  it("changes the revision when the font changes", async () => {
    const d = await doc("serif");
    const before = (await previewDocument(ctx, user, d.id)).revision;
    await updateDocument(ctx, user, d.id, { font: "sans-serif" });
    expect((await previewDocument(ctx, user, d.id)).revision).not.toBe(before);
  });

  it("rejects other values", async () => {
    await expect(doc("comic-sans")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(setContractFont(ctx, user, "monospace")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("renders the PDF body in the chosen family", async () => {
    const serif = await doc("serif");
    const sans = await doc("sans-serif");
    expect(await pdfFonts(serif.id, `font${n - 1}@x.example`)).toContain("SourceSerif4");
    expect(await pdfFonts(sans.id, `font${n}@x.example`)).not.toContain("SourceSerif4");
  }, 60_000);
});
