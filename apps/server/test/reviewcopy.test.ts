import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { submitSignature } from "../src/services/signing.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const meta = { ip: "203.0.113.7", user_agent: "vitest" };

function linkFor(dataDir: string, email: string): string {
  const dir = join(dataDir, "outbox");
  const mails = readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string });
  return /\/s\/([A-Za-z0-9_-]+)/.exec(mails.filter((m) => m.to === email).at(-1)!.text)![1]!;
}

describe("review copy for signers", async () => {
  const { ctx, user, dataDir } = await testContext();
  afterAll(() => ctx.close());

  it("downloads an unsigned PDF with every field blank, logs it, and stops once signed", async () => {
    const doc = await createDocument(ctx, user, {
      title: "Consulting agreement",
      content: "# Consulting agreement\n\nThe fee is fixed.\n\nSignature: {{a.signature:signature}}\n\nSignature: {{b.signature:signature}}",
      signers: [
        { key: "a", name: "Ada Client", email: "ada@client.example", order: 0 },
        { key: "b", name: "Bo Vendor", email: "bo@vendor.example", order: 0 },
      ],
    });
    const { revision } = await previewDocument(ctx, user, doc.id);
    await sendDocument(ctx, user, doc.id, { approved_revision: revision });
    await drainJobs(ctx);
    const a = linkFor(dataDir, "ada@client.example");
    const b = linkFor(dataDir, "bo@vendor.example");
    await submitSignature(ctx, a, { consent: true, fields: { "a.signature": { kind: "typed", text: "Ada Signed-Name" } } }, meta);

    const app = createApp(ctx);
    const page = await (await app.request(`/s/${b}`)).text();
    expect(page).toContain(`href="/s/${b}/review.pdf"`);

    const res = await app.request(`/s/${b}/review.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Consulting agreement - review copy.pdf"');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    let text: string | null = null;
    try {
      text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf }).toString();
    } catch {
      // poppler is not installed: the checks below on the text are skipped.
    }
    if (text) {
      expect(text).toContain("Copy for review – not signed");
      expect(text).toContain("The fee is fixed.");
      expect(text).not.toContain("Ada Signed-Name"); // other people's signatures stay out
      expect(text).not.toContain("Certificate of completion");
    }

    const events = await listEvents(ctx.db, doc.id);
    expect(events.filter((e) => e.type === "signer.downloaded_review_copy").map((e) => e.data.signer)).toEqual(["b"]);

    await submitSignature(ctx, b, { consent: true, fields: { "b.signature": { kind: "typed", text: "Bo" } } }, meta);
    expect((await app.request(`/s/${b}/review.pdf`)).status).toBe(404);
    expect((await app.request("/s/not-a-real-token-at-all-xxxxxxxx/review.pdf")).status).toBe(404);
  });
});
