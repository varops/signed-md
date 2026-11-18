import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { csrfToken, login } from "../src/services/auth.ts";
import { testContext } from "./helpers.ts";

describe("editor preview", async () => {
  const { ctx } = await testContext();
  afterAll(() => ctx.close());
  const app = createApp(ctx);
  const s = (await login(ctx, "admin@automaze.example", "correct horse battery"))!;
  const cookie = `smd_session=${s.token}`;
  const csrf = csrfToken(ctx, s.token);
  const preview = (source: string, extra: Record<string, string> = {}, token = csrf) =>
    app.request("/preview", { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: token, source, ...extra }) });

  const SOURCE = "# Deal\n\nBetween {{$party:text}}.\n\n<!-- columns -->\n\n**A**\n\n{{a.signature:signature}}\n\n<!-- column -->\n\n**B**\n\n{{b.signature:signature}}\n\n<!-- /columns -->\n";

  it("renders columns and field chips", async () => {
    const res = await preview(SOURCE, { font: "sans-serif" });
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain('<div class="smd-columns smd-columns-2">');
    expect(out).toContain("signature – a");
    expect(out).toContain('class="smd-field smd-field-value"');
    expect(out).toMatch(/<article class="doc [^"]*">/);
    expect(out).not.toContain("<html");
    expect(out).not.toContain("Fix before saving");
  });

  it("lists problems above the preview", async () => {
    const out = await (await preview("Hi\n\n<!-- columns -->\n\nA")).text();
    expect(out).toContain("Fix before saving");
    expect(out).toContain("not closed");
  });

  it("keeps raw HTML out", async () => {
    const out = await (await preview("<script>alert(1)</script>\n\n<div class=\"smd-columns\">x</div>")).text();
    expect(out).not.toContain("<script");
    expect(out).not.toContain('<div class="smd-columns">');
  });

  it("needs a session and a form token", async () => {
    expect((await preview(SOURCE, {}, "wrong")).status).toBe(403);
    const anon = await app.request("/preview", { method: "POST", body: new URLSearchParams({ source: SOURCE }) });
    expect(anon.status).toBe(302);
  });

  it("shows the editor with a server-rendered preview", async () => {
    const page = await (await app.request("/templates/new", { headers: { cookie } })).text();
    expect(page).toContain("data-preview-source");
    expect(page).toMatch(/data-preview-target[^>]*>[\s\S]*<article class="doc/);
  });
});
