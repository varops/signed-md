import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseTemplate } from "@signed-md/core";
import { buildTypst, renderPdf, type PdfInput } from "../src/services/pdf.ts";

const CONTENT = `# Agreement

Terms.

<!-- columns -->

**Acme Ltd**

Signature: {{a.signature:signature}}

<!-- column -->

**Globex Inc**

Signature: {{b.signature:signature}}

<!-- /columns -->
`;

const input: PdfInput = {
  title: "Agreement",
  documentId: "doc_test",
  revision: "rev",
  content: CONTENT,
  contentSha256: "0".repeat(64),
  fields: parseTemplate(CONTENT).fields,
  values: new Map([
    ["a.signature", { kind: "typed", text: "Ada Acme" }],
    ["b.signature", { kind: "typed", text: "Gil Globex" }],
  ]),
  signers: [],
  sender: null,
  source: "ui",
  sentAt: null,
  completedAt: "2026-01-01T00:00:00.000Z",
  accountName: "Acme",
  publicUrl: "http://localhost:3000",
  keyId: "key",
  timezone: "UTC",
  sealedBy: "CN=test",
  timestampAuthority: null,
  disclosureVersion: "1",
  font: "serif",
};

describe("columns in the PDF", () => {
  it("lays the blocks out in one unbreakable grid", () => {
    const { source } = buildTypst(input);
    expect(source).toContain("#block(breakable: false, width: 100%, above: 2.2em, grid(columns: (1fr, 1fr,), column-gutter: 22pt, [");
    expect(source).not.toContain("<!--");
  });

  it("compiles, with both parties on the same line of the page", async () => {
    const pdf = await renderPdf(process.env.TYPST_BIN ?? "typst", input);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf }).toString();
    } catch {
      return; // poppler is not installed: compiling is enough.
    }
    expect(text).toMatch(/Acme Ltd\s+Globex Inc/);
    expect(text).toMatch(/Ada Acme\s+.*Gil Globex/);
  });
});
