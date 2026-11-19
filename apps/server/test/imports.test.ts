import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createSession, csrfToken } from "../src/services/auth.ts";
import { importDocument } from "../src/services/imports.ts";
import { testContext } from "./helpers.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));

describe("importing Word and PDF files", () => {
  it("converts a PDF to Markdown, keeping headings, and names it from the first heading", async () => {
    const r = await importDocument("nda.pdf", fixture("nda.pdf"));
    expect(r.title).toBe("Mutual Non-Disclosure Agreement");
    expect(r.markdown).toMatch(/^# Mutual Non-Disclosure Agreement/m);
    expect(r.markdown).toMatch(/^## 2\. Signatures/m);
  });

  it("converts a Word file, and keeps literal double braces as text", async () => {
    const r = await importDocument("nda.docx", fixture("nda.docx"));
    expect(r.markdown).toContain("Acme Ltd");
    expect(r.markdown).toContain("\\{{3}}");
    expect(r.title).toBe("nda");
  });

  it("refuses empty, oversized and unsupported files", async () => {
    await expect(importDocument("x.pdf", new Uint8Array())).rejects.toThrow(/Choose a file/);
    await expect(importDocument("x.txt", new TextEncoder().encode("hello"))).rejects.toThrow(/Import a Word/);
    await expect(importDocument("x.pdf", new Uint8Array(4 * 1024 * 1024))).rejects.toThrow(/at most 3 MB/);
  });
});

describe("import pages", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());

  it("opens a new template prefilled from the uploaded file, without saving it", async () => {
    const app = createApp(ctx);
    const token = await createSession(ctx, user.id);
    const form = new FormData();
    form.set("_csrf", csrfToken(ctx, token));
    form.set("file", new File([fixture("nda.pdf")], "nda.pdf", { type: "application/pdf" }));
    const page = await (await app.request("/templates/import", { method: "POST", body: form, headers: { cookie: `smd_session=${token}` } })).text();
    expect(page).toContain("Converted from nda.pdf");
    expect(page).toContain('value="Mutual Non-Disclosure Agreement"');
    expect(page).toContain("## 1. Confidential information");
    expect(await ctx.db.selectFrom("templates").select("id").execute()).toHaveLength(0);
  });
});
