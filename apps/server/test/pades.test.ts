import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPackageFiles, verifyPdfSignature } from "@signed-md/core";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { listArtifacts, readArtifact } from "../src/services/finalize.ts";
import { recordConsent, submitSignature } from "../src/services/signing.ts";
import { drainJobs } from "../src/worker.ts";
import { startFakeTsa } from "./fakeTsa.ts";
import { testContext } from "./helpers.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const meta = { ip: "203.0.113.9", user_agent: "vitest" };

function hasPdfsig(): boolean {
  try {
    execFileSync("pdfsig", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("PAdES-sealed PDF with trusted timestamps", async () => {
  const tsa = await startFakeTsa();
  const { ctx, user, dataDir } = await testContext({ TSA_URL: tsa.url });
  afterAll(async () => {
    await ctx.close();
    await tsa.close();
  });

  let n = 0;
  async function completeDocument(): Promise<Record<string, Uint8Array>> {
    const email = `alex${++n}@client.example`;
    const d = await createDocument(ctx, user, { content: "# Agreement\n\nSigned: {{a.signature:signature}}", signers: [{ key: "a", name: "Alex Signer", email }] });
    await sendDocument(ctx, user, d.id, { approved_revision: (await previewDocument(ctx, user, d.id)).revision });
    await drainJobs(ctx);
    const dir = join(dataDir, "outbox");
    const { readdirSync } = await import("node:fs");
    const mail = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { to: string; text: string }).find((m) => m.to === email)!;
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    await recordConsent(ctx, token, meta);
    await submitSignature(ctx, token, { consent: false, fields: { "a.signature": { kind: "drawn", image: PNG } } }, meta);
    await drainJobs(ctx);
    const zip = (await listArtifacts(ctx, user, d.id)).find((a) => a.type === "zip")!;
    return unzipSync(new Uint8Array((await readArtifact(ctx, zip.id))!.data));
  }

  it("signs the PDF (PAdES B-T), timestamps the package, and verifies offline", async () => {
    const files = await completeDocument();
    expect(Object.keys(files)).toContain("manifest.tsr");
    const report = verifyPackageFiles(files, { trustedKeys: [ctx.keys.info.public_key] });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.timestamp?.authority).toContain("Test Timestamp Authority");
    expect(report.pdf_signature?.signer).toContain("Automaze (Signed.md)");
    expect(report.pdf_signature?.timestamp_authority).toContain("Test Timestamp Authority");
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["PDF signature valid", "PDF not changed after signing", "PDF signed by this installation's certificate", "PDF signature timestamp", "package timestamp"]));
    expect(tsa.requests()).toBeGreaterThanOrEqual(2); // the PDF signature and the package
    // The PDF is PDF/A-2b.
    expect(Buffer.from(files["signed.pdf"]!).toString("latin1")).toContain("pdfaid:part");
    // PDF/A rule 6.1.3-1: the signature's incremental update keeps the document /ID in its trailer.
    const text = Buffer.from(files["signed.pdf"]!).toString("latin1");
    const trailers = [...text.matchAll(/trailer\s*<<([\s\S]*?)>>\s*startxref/g)].map((m) => m[1]!);
    expect(trailers.length).toBe(2);
    for (const t of trailers) expect(t).toMatch(/\/ID\s*\[/);
  }, 60_000);

  it("detects a changed PDF", async () => {
    const files = await completeDocument();
    const pdf = Buffer.from(files["signed.pdf"]!);
    const i = pdf.indexOf("Agreement");
    pdf[i] = "a".charCodeAt(0);
    const check = verifyPdfSignature(pdf)!;
    expect(check.checks.find((c) => c.name === "PDF signature valid")!.ok).toBe(false);
  }, 60_000);

  it.skipIf(!hasPdfsig())("passes an independent validator (poppler pdfsig)", async () => {
    const files = await completeDocument();
    const { writeFileSync } = await import("node:fs");
    const path = join(dataDir, "check.pdf");
    writeFileSync(path, files["signed.pdf"]!);
    const out = execFileSync("pdfsig", ["-nocert", path]).toString();
    expect(out).toContain("Signature is Valid");
    expect(out).toContain("ETSI.CAdES.detached");
    expect(out).toContain("Total document signed");
  }, 60_000);
});
