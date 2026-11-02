import { type FieldDef, renderHtml, SignedError } from "@signed-md/core";
import type { ElementContent, Element } from "hast";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import type { Ctx } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { clientIp, rateLimit } from "../http/ratelimit.ts";
import { downloadLink } from "../services/finalize.ts";
import { getAccount } from "../services/accounts.ts";
import {
  declineDocument,
  fieldLabel,
  openSigningPage,
  recordConsent,
  renderCompletedValue,
  type RequestMeta,
  type SignerView,
  submitSignature,
} from "../services/signing.ts";
import { type FormBody, str } from "./forms.ts";
import { footer, type H } from "./layout.ts";

function publicShell(title: string, account: string | null, body: H, opts: { scripts?: boolean; bodyClass?: string } = {}): H {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${title}</title><link rel="stylesheet" href="/assets/app.css"></head><body class="${opts.bodyClass ?? ""}">
${body}
${footer()}
${opts.scripts ? html`<script src="/assets/signature_pad.js"></script><script src="/assets/sign.js"></script>` : ""}
</body></html>`;
}

let logoVersion: string | null = null;

function brandBar(account: string | null): H {
  const name = account ?? "Signed.md";
  return html`<header class="sign-head"><div class="inner">${logoVersion ? html`<img class="brand-logo" src="/branding/logo?v=${logoVersion}" alt="${name}">` : html`<strong>${name}</strong>`}<span class="small muted">Secured by Signed.md</span></div></header>`;
}

function message(title: string, text: string, extra?: H): H {
  return publicShell(title, null, html`${brandBar(null)}<main class="sign-wrap"><div class="card intro-card" style="text-align:center"><h1>${title}</h1><p class="muted">${text}</p>${extra ?? ""}</div></main>`);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((p) => p[0]!.toUpperCase()).join("").slice(0, 4);
}

function declineBlock(token: string): H {
  return html`<details class="other-actions"><summary>Other actions</summary>
    <form method="post" action="/s/${token}/decline" class="card" style="margin-top:10px">
      <h3>Decline to sign</h3>
      <p class="small muted">The sender will be told. You can add a reason.</p>
      <div class="field"><textarea name="reason" style="min-height:80px" placeholder="Reason (optional)"></textarea></div>
      <button class="btn danger">Decline</button></form></details>`;
}

// ---- Step 1: "Let's start" ----

function introPage(token: string, view: SignerView, error: string | null): H {
  const due = view.expires_at ? new Date(view.expires_at).toUTCString().replace(/ \d\d:\d\d:\d\d GMT/, "") : null;
  return publicShell(view.title, view.account_name, html`${brandBar(view.account_name)}
    <main class="sign-wrap">
      <div class="card intro-card">
        <div class="intro-icon" aria-hidden="true">✍︎</div>
        <p class="muted" style="margin-bottom:4px">${view.sender_name ? `${view.sender_name} at ${view.account_name}` : view.account_name} sent you a document to review and sign</p>
        <h1>${view.title}</h1>
        <dl class="kv small" style="margin:14px 0 20px"><dt>For</dt><dd>${view.signer.name} (${view.signer.email})</dd>
          <dt>Fields</dt><dd>${view.fields.length} to complete</dd>
          ${view.progress.total > 1 ? html`<dt>Signers</dt><dd>${view.progress.signed} of ${view.progress.total} have signed</dd>` : ""}
          ${due ? html`<dt>Due</dt><dd>${due}</dd>` : ""}</dl>
        ${error ? html`<div class="notice bad">${error}</div>` : ""}
        <form method="post" action="/s/${token}/start">
          <div class="disclosure"><strong>Electronic record and signature disclosure</strong><p>${view.consent_text}</p>
            <details style="margin-top:8px"><summary>Read the full disclosure</summary><pre class="disclosure-full">${view.disclosure}</pre></details></div>
          <label class="check" style="margin:14px 0 18px"><input type="checkbox" name="consent" required> <span>I agree to use electronic records and signatures.</span></label>
          <button class="btn go block">Continue</button>
        </form>
      </div>
      ${declineBlock(token)}
    </main>`);
}

// ---- Step 2: the document with inline fields ----

function el(tagName: string, properties: Record<string, unknown>, children: ElementContent[] = []): Element {
  return { type: "element", tagName, properties: properties as Element["properties"], children };
}
const text = (value: string): ElementContent => ({ type: "text", value });

function inlineField(def: FieldDef, prior: FormBody | null, firstSeen: Set<string>): ElementContent {
  const name = `f:${def.key}`;
  const label = def.rules.label ?? fieldLabel(def);
  const required = def.rules.required !== false;
  const common = { dataField: def.key, dataType: def.type, ...(required ? { dataRequired: "1" } : {}), title: label, ariaLabel: label };

  // A field used more than once in the text is edited at its first position; later copies mirror it.
  if (firstSeen.has(def.key)) return el("span", { className: ["smd-mirror"], dataMirror: def.key }, [text(def.type === "signature" || def.type === "initials" ? "" : "…")]);
  firstSeen.add(def.key);

  const v = prior ? str(prior, name) : "";
  switch (def.type) {
    case "signature":
    case "initials": {
      const kind = prior ? str(prior, `${name}:kind`) : "";
      const image = prior ? str(prior, `${name}:image`) : "";
      const typed = prior ? str(prior, `${name}:text`) : "";
      const done = (kind === "drawn" && image) || (kind === "typed" && typed);
      return el("span", { className: ["smd-sign", done ? "smd-done" : ""], ...common, dataSign: def.type }, [
        el("button", { type: "button", className: ["smd-sign-tag"] }, [text(def.type === "initials" ? "Initial" : "Sign")]),
        el("span", { className: ["smd-sign-value"] }, done ? [kind === "drawn" ? el("img", { src: image, alt: label }) : el("span", { className: ["smd-signature-typed"] }, [text(typed)])] : []),
        el("input", { type: "hidden", name: `${name}:kind`, value: kind || "typed" }),
        el("input", { type: "hidden", name: `${name}:image`, value: image }),
        // Without JavaScript the signer types their name here.
        el("input", { type: "text", className: ["smd-sign-fallback"], name: `${name}:text`, value: typed, placeholder: def.type === "initials" ? "Type initials" : "Type full name" }),
      ]);
    }
    case "date":
      return el("input", { type: "date", className: ["smd-input"], name, value: v, ...common });
    case "checkbox":
      return el("input", { type: "checkbox", className: ["smd-check"], name, ...(v === "on" ? { checked: true } : {}), ...common });
    case "choice":
      return el("select", { className: ["smd-input"], name, ...common }, [
        el("option", { value: "" }, [text(label)]),
        ...(def.rules.options ?? []).map((o) => el("option", { ...(String(o) === v ? { selected: true } : {}) }, [text(String(o))])),
      ]);
    case "longtext":
      return el("textarea", { className: ["smd-input", "smd-textarea"], name, placeholder: label, ...common }, [text(v)]);
    default:
      return el("input", {
        type: "text",
        className: ["smd-input"],
        name,
        value: v,
        placeholder: label,
        size: Math.max(Math.min(label.length + 2, 28), 10),
        ...(def.type === "number" || def.type === "currency" ? { inputMode: "decimal" } : {}),
        ...common,
      });
  }
}

function signingPage(token: string, view: SignerView, error: SignedError | null, prior: FormBody | null): H {
  const firstSeen = new Set<string>();
  const docHtml = renderHtml(view.content, {
    fields: view.defs,
    renderField: (def) => {
      const done = view.completed[def.key];
      if (done !== undefined) return renderCompletedValue(def, done);
      if (def.signer === view.signer.key) return inlineField(def, prior, firstSeen);
      return el("span", { className: ["smd-slot", "smd-slot-other"] }, [text(`${def.rules.label ?? fieldLabel(def)} – ${view.names[def.signer!] ?? def.signer}`)]);
    },
  });
  const required = view.fields.filter((f) => f.required).length;
  return publicShell(view.title, view.account_name, html`
    <form method="post" action="/s/${token}" id="sign-form" novalidate>
      <div class="guide-bar"><div class="inner">
        <div class="guide-info"><strong class="guide-title">${view.title}</strong><span class="small muted" id="guide-progress">${required} required field${required === 1 ? "" : "s"}</span></div>
        <div class="row" style="gap:8px">
          <button type="button" class="btn go" id="guide-next">Start</button>
          <button type="submit" class="btn primary" id="guide-finish">Finish</button>
        </div>
      </div></div>
      <main class="sign-wrap">
        ${logoVersion ? html`<div class="sign-logo"><img class="brand-logo" src="/branding/logo?v=${logoVersion}" alt="${view.account_name}"></div>` : ""}
        ${error ? html`<div class="notice bad" id="sign-error">${error.message}${error.issues.length ? html`<ul>${error.issues.map((i) => html`<li>${i.message}</li>`)}</ul>` : ""}</div>` : ""}
        <p class="small muted guide-hint">Fill in the highlighted fields in the document. Use <strong>Next</strong> to jump between them, then <strong>Finish</strong>.</p>
        <article class="doc signing">${raw(docHtml)}</article>
        <div class="finish-row"><button type="submit" class="btn primary">Finish</button></div>
      </main>
    </form>
    <main class="sign-wrap" style="padding-top:0">${declineBlock(token)}</main>

    <dialog id="adopt" data-name="${view.signer.name}" data-initials="${initials(view.signer.name)}">
      <form method="dialog" class="adopt">
        <div class="spread"><h2 style="margin:0" id="adopt-title">Adopt your signature</h2><button value="cancel" class="btn small" aria-label="Close">✕</button></div>
        <p class="small muted">Confirm your name and choose how your signature looks.</p>
        <div class="tabs"><button type="button" data-mode="typed" class="active">Type</button><button type="button" data-mode="drawn">Draw</button></div>
        <div data-pane="typed">
          <div class="field"><label for="adopt-text" id="adopt-text-label">Full name</label><input type="text" id="adopt-text" autocomplete="name"></div>
          <div class="typed-preview" id="adopt-preview"></div>
        </div>
        <div data-pane="drawn" class="hidden"><canvas class="sig-pad" id="adopt-pad" aria-label="Draw here"></canvas><a href="#" id="adopt-clear" class="small">Clear</a></div>
        <p class="small muted">By selecting Adopt and sign, I agree that this is my electronic ${"signature"} for this document.</p>
        <div class="row" style="justify-content:flex-end"><button value="cancel" class="btn">Cancel</button><button type="button" class="btn go" id="adopt-ok">Adopt and sign</button></div>
      </form>
    </dialog>`, { scripts: true, bodyClass: "signing-body" });
}

function collectFields(view: SignerView, b: FormBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of view.fields) {
    const name = `f:${f.key}`;
    if (f.type === "signature" || f.type === "initials") {
      const kind = str(b, `${name}:kind`);
      const image = str(b, `${name}:image`);
      const typed = str(b, `${name}:text`).trim();
      if (kind === "drawn" && image) out[f.key] = { kind: "drawn", image };
      else if (typed) out[f.key] = { kind: "typed", text: typed };
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
    logoVersion = (await getAccount(ctx)).config.branding.logo?.sha256.slice(0, 8) ?? null;
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
          const s = await ctx.db.selectFrom("signers").select("document_id").where("token_hash", "=", sha256(token)).executeTakeFirst();
          const pdf = s ? await ctx.db.selectFrom("artifacts").select("id").where("document_id", "=", s.document_id).where("type", "=", "pdf").executeTakeFirst() : undefined;
          if (pdf) extra = html`<a class="btn primary" href="${downloadLink(ctx, pdf.id, 600).url}">Download signed PDF</a>`;
        }
        const msg = state.document_status === "finalized" || state.document_status === "signed"
          ? `Everyone has signed “${state.title}”. A copy has been emailed to you.`
          : `Thank you, ${state.signer_name}. You signed “${state.title}”. You'll receive a copy by email when everyone has signed.`;
        return c.html(message("You're done", msg, extra));
      }
      case "sign":
        if (!state.view.consented) return c.html(introPage(token, state.view, null));
        return c.html(signingPage(token, state.view, error, prior), error ? 422 : 200);
    }
  };

  app.get("/s/:token", (c) => render(c, c.req.param("token")));

  app.post("/s/:token/start", async (c) => {
    const token = c.req.param("token");
    const b = (await c.req.parseBody()) as FormBody;
    if (str(b, "consent") !== "on") {
      const state = await openSigningPage(ctx, token, meta(c));
      if (state.state !== "sign") return render(c, token);
      return c.html(introPage(token, state.view, "Please agree to use electronic records and signatures to continue."), 422);
    }
    try {
      await recordConsent(ctx, token, meta(c));
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
    }
    return c.redirect(`/s/${token}`);
  });

  app.post("/s/:token", async (c) => {
    const token = c.req.param("token");
    const b = (await c.req.parseBody()) as FormBody;
    const state = await openSigningPage(ctx, token, meta(c));
    if (state.state !== "sign") return render(c, token);
    try {
      await submitSignature(ctx, token, { consent: state.view.consented, fields: collectFields(state.view, b) }, meta(c));
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
