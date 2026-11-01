import { SignedError } from "@signed-md/core";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import type { Ctx } from "../context.ts";
import { clientIp, rateLimit } from "../http/ratelimit.ts";
import { downloadLink } from "../services/finalize.ts";
import { declineDocument, openSigningPage, type RequestMeta, type SignerView, submitSignature } from "../services/signing.ts";
import { type FormBody, str } from "./forms.ts";
import type { H } from "./layout.ts";

function publicShell(title: string, account: string | null, body: H, scripts = false): H {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${title}</title><link rel="stylesheet" href="/assets/app.css"></head><body>
<header class="sign-head"><div class="inner"><strong>${account ?? "Signed.md"}</strong><span class="small muted">Secured by Signed.md</span></div></header>
<main class="sign-wrap">${body}</main>
${scripts ? html`<script src="/assets/signature_pad.js"></script><script src="/assets/sign.js"></script>` : ""}
</body></html>`;
}

function message(title: string, text: string, extra?: H): H {
  return publicShell(title, null, html`<div class="card" style="max-width:560px;margin:40px auto;text-align:center"><h1>${title}</h1><p class="muted">${text}</p>${extra ?? ""}</div>`);
}

function fieldInput(f: SignerView["fields"][number], prior: FormBody | null): H {
  const name = `f:${f.key}`;
  const v = prior ? str(prior, name) : "";
  const id = `field-${f.key.replace(/[^a-z0-9_-]/gi, "-")}`;
  const req = f.required ? html`<span class="muted">· required</span>` : html`<span class="muted">· optional</span>`;
  if (f.type === "signature" || f.type === "initials") {
    const typed = prior ? str(prior, `${name}:text`) : "";
    return html`<div class="field" id="${id}" data-sig="${f.key}"><label>${f.label} ${req}</label>
      <input type="hidden" name="${name}:kind" value="typed"><input type="hidden" name="${name}:image" value="">
      <div class="tabs hidden"><button data-mode="drawn">Draw</button><button data-mode="typed">Type</button></div>
      <div data-pane="draw" class="hidden"><canvas class="sig-pad" aria-label="Draw your ${f.type}"></canvas><a href="#" data-clear class="small">Clear</a></div>
      <div data-pane="type"><input type="text" name="${name}:text" value="${typed}" placeholder="${f.type === "initials" ? "Your initials" : "Type your full name"}" autocomplete="name"><div class="typed-preview">${typed}</div></div>
    </div>`;
  }
  if (f.type === "date") return html`<div class="field" id="${id}"><label for="${name}">${f.label} ${req}</label><input type="date" id="${name}" name="${name}" value="${v}"></div>`;
  if (f.type === "longtext") return html`<div class="field" id="${id}"><label for="${name}">${f.label} ${req}</label><textarea id="${name}" name="${name}">${v}</textarea></div>`;
  if (f.type === "checkbox") return html`<div class="field" id="${id}"><label class="check"><input type="checkbox" name="${name}" ${v === "on" ? "checked" : ""}> ${f.label}</label></div>`;
  if (f.type === "choice") {
    return html`<div class="field" id="${id}"><label for="${name}">${f.label} ${req}</label><select id="${name}" name="${name}"><option value="">Choose…</option>${(f.options ?? []).map((o) => html`<option ${o === v ? "selected" : ""}>${o}</option>`)}</select></div>`;
  }
  return html`<div class="field" id="${id}"><label for="${name}">${f.label} ${req}</label><input type="text" id="${name}" name="${name}" value="${v}" ${f.type === "number" || f.type === "currency" ? html`inputmode="decimal"` : ""}></div>`;
}

function signPage(token: string, view: SignerView, error: SignedError | null, prior: FormBody | null): H {
  return publicShell(view.title, view.account_name, html`
    <div class="spread" style="margin-bottom:16px"><div><h1 style="margin:0">${view.title}</h1><div class="small muted">${view.account_name} asks ${view.signer.name} to sign · ${view.progress.signed} of ${view.progress.total} signed</div></div></div>
    ${error ? html`<div class="notice bad">${error.message}${error.issues.length ? html`<ul>${error.issues.map((i) => html`<li>${i.message}</li>`)}</ul>` : ""}</div>` : ""}
    <article class="doc">${raw(view.html)}</article>
    <form method="post" action="/s/${token}" class="card" id="sign-form" style="margin-top:20px">
      <h2>Your details</h2>
      ${view.fields.map((f) => fieldInput(f, prior))}
      <label class="check" style="margin:18px 0"><input type="checkbox" name="consent" ${prior && str(prior, "consent") === "on" ? "checked" : ""}> <span>${view.consent_text}</span></label>
      <button type="submit" class="btn primary block">Sign document</button>
    </form>
    <details class="card"><summary>Decline to sign</summary>
      <form method="post" action="/s/${token}/decline" style="margin-top:12px">
        <div class="field"><label>Reason <span class="muted">· optional, shared with the sender</span></label><textarea name="reason" style="min-height:80px"></textarea></div>
        <button class="btn danger">Decline</button></form></details>`, true);
}

function collectFields(view: SignerView, b: FormBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of view.fields) {
    const name = `f:${f.key}`;
    if (f.type === "signature" || f.type === "initials") {
      const kind = str(b, `${name}:kind`);
      const image = str(b, `${name}:image`);
      const text = str(b, `${name}:text`).trim();
      if (kind === "drawn" && image) out[f.key] = { kind: "drawn", image };
      else if (text) out[f.key] = { kind: "typed", text };
    } else if (f.type === "checkbox") {
      out[f.key] = str(b, name) === "on";
    } else {
      const v = str(b, name).trim();
      if (v) out[f.key] = v;
    }
  }
  return out;
}

export function createSigningRoutes(ctx: Ctx) {
  const app = new Hono();
  const limit = rateLimit({ windowMs: 60_000, max: 60, key: (c) => `sign:${clientIp(c)}` });
  const meta = (c: Context): RequestMeta => ({ ip: clientIp(c), user_agent: c.req.header("user-agent")?.slice(0, 300) ?? null });

  app.use("/s/*", limit);
  app.use("/s/*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
    await next();
  });

  const render = async (c: Context, token: string, error: SignedError | null = null, prior: FormBody | null = null) => {
    const state = await openSigningPage(ctx, token, meta(c));
    switch (state.state) {
      case "invalid":
        return c.html(message("Link not valid", "This signing link is not valid or has been replaced by a newer one. Ask the sender to resend it."), 404);
      case "revoked":
        return c.html(message("Document cancelled", `The sender cancelled “${state.title}”. You don't need to do anything.`), 410);
      case "declined":
        return c.html(message("Document declined", `“${state.title}” was declined, so it can no longer be signed.`), 410);
      case "expired":
        return c.html(message("Link expired", `“${state.title}” expired before it was signed. Ask the sender for a new one.`), 410);
      case "signed": {
        let extra: H | undefined;
        if (state.document_status === "finalized") {
          const s = await ctx.db.selectFrom("signers").select("document_id").where("token_hash", "=", (await import("../crypto.ts")).sha256(token)).executeTakeFirst();
          const pdf = s ? await ctx.db.selectFrom("artifacts").select("id").where("document_id", "=", s.document_id).where("type", "=", "pdf").executeTakeFirst() : undefined;
          if (pdf) extra = html`<a class="btn primary" href="${downloadLink(ctx, pdf.id, 600).url}">Download signed PDF</a>`;
        }
        const text = state.document_status === "finalized" || state.document_status === "signed"
          ? `Everyone has signed “${state.title}”. A copy has been emailed to you.`
          : `Thank you, ${state.signer_name}. You signed “${state.title}”. You'll receive a copy by email when everyone has signed.`;
        return c.html(message("Signed", text, extra));
      }
      case "sign":
        return c.html(signPage(token, state.view, error, prior), error ? 422 : 200);
    }
  };

  app.get("/s/:token", (c) => render(c, c.req.param("token")));

  app.post("/s/:token", async (c) => {
    const token = c.req.param("token");
    const b = (await c.req.parseBody()) as FormBody;
    const state = await openSigningPage(ctx, token, meta(c));
    if (state.state !== "sign") return render(c, token);
    try {
      await submitSignature(ctx, token, { consent: str(b, "consent") === "on", fields: collectFields(state.view, b) }, meta(c));
      return c.redirect(`/s/${token}`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return render(c, token, e, b);
    }
  });

  app.post("/s/:token/decline", async (c) => {
    const token = c.req.param("token");
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await declineDocument(ctx, token, str(b, "reason"), meta(c));
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return c.html(message("Could not decline", e.message), 409);
    }
    return c.html(message("Declined", "You declined this document. The sender has been told."));
  });

  return app;
}
