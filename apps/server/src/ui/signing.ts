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
import { alert, asset, avatarFigure, field, footer, type H, head, icon } from "./layout.ts";
import { CONTRACT_FONTS } from "../services/fonts.ts";

/** Signing pages follow the signer's device for light and dark. */
function publicShell(title: string, account: string | null, body: H, opts: { scripts?: boolean; bodyClass?: string; footer?: boolean } = {}): H {
  return html`<!doctype html><html lang="en"><head>${head(title)}
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"></head><body class="${opts.bodyClass ?? ""}">
${body}
${opts.footer === false ? "" : footer()}
${opts.scripts ? html`<script src="${asset("signature_pad.js")}"></script><script src="${asset("sign.js")}"></script>` : ""}
</body></html>`;
}

let logoVersion: string | null = null;

/**
 * The company's logo at the top of the card, on a light tile so a dark logo still shows in dark
 * mode. Without a logo, the intro shows the Signed.md signing icon instead (message pages show nothing).
 */
function companyLogo(account: string | null, fallback: H | string = ""): H | string {
  return logoVersion
    ? html`<div class="intro-logo"><img src="/branding/logo?v=${logoVersion}" alt="${account ?? "Company logo"}"></div>`
    : fallback;
}

function message(title: string, text: string, extra?: H): H {
  return publicShell(title, null, html`<main class="sign-wrap"><section class="card intro-card message-card" aria-labelledby="message-title">${companyLogo(null)}<h1 id="message-title">${title}</h1><p class="muted">${text}</p>${extra ?? ""}</section></main>`);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((p) => p[0]!.toUpperCase()).join("").slice(0, 4);
}

/**
 * Beside the document: the document's progress. It was sent, each signer in order (with "You are
 * here" and "Next"), then the signed copy goes to everyone. The due date sits above.
 */
function progressPanel(view: SignerView, token: string): H {
  const label = { signed: "Signed", declined: "Declined", you: "You are here", now: "Signing now", next: "Next", later: "After that" } as const;
  const day = (iso: string) => new Date(iso).toUTCString().replace(/ \d\d:\d\d:\d\d GMT/, "");
  const anyOrder = view.timeline.length > 1 && view.timeline.every((s) => s.order === view.timeline[0]!.order);
  return html`<aside class="sign-aside" aria-label="Progress and other actions">
    <section class="card progress-card" aria-labelledby="progress-title">
      <h2 id="progress-title">Progress</h2>
      ${view.expires_at ? html`<p class="small muted due-line">To be finalized by ${day(view.expires_at)}</p>` : ""}
      <ol class="signer-timeline">
        <li data-state="done"><span class="step-dot" aria-hidden="true">${icon("send")}</span>
          <div><strong>Document sent</strong>${view.sent_at ? html`<span class="tl-state">${day(view.sent_at)}</span>` : ""}</div></li>
        ${view.timeline.map((s) => html`<li data-state="${s.state}" ${s.state === "you" ? html`aria-current="step"` : ""}>
          ${avatarFigure(s.name, null, "small")}
          <div><strong>${s.name}${s.state === "you" ? html` <span class="muted">(you)</span>` : ""}</strong><span class="tl-state">${label[s.state]}</span></div>
        </li>`)}
        <li data-state="later"><span class="step-dot" aria-hidden="true">${icon("package")}</span>
          <div><strong>Finalized</strong><span class="tl-state">The signed copy is emailed to everyone</span></div></li>
      </ol>
      ${anyOrder ? html`<p class="tiny muted" style="margin:12px 0 0">Everyone signs at the same time, in any order.</p>` : ""}
    </section>
    ${declineBlock(token)}
    ${footer()}
  </aside>`;
}

function declineBlock(token: string): H {
  // The fields belong to a form placed outside the signing form (forms can't be nested), so this
  // block can sit anywhere, including beside the document inside the signing form.
  return html`<details class="other-actions"><summary>Other actions</summary>
    <div role="group" aria-labelledby="decline-title" aria-describedby="decline-note">
      <h5 id="decline-title">Decline to sign</h5>
      <p class="small muted" id="decline-note">The sender will be told. You can add a reason.</p>
      ${field("decline-reason", html`Reason <span class="muted">· optional</span>`, html`<textarea id="decline-reason" name="reason" form="decline-form" style="min-height:80px"></textarea>`)}
      <button type="submit" form="decline-form" data-variant="danger">Decline</button></div></details>`;
}

/** The form that "Decline" submits, outside every other form. */
function declineForm(token: string): H {
  return html`<form method="post" action="/s/${token}/decline" id="decline-form" hidden></form>`;
}

// ---- Step 1: "Let's start" ----

function introPage(token: string, view: SignerView, error: string | null): H {
  const due = view.expires_at ? new Date(view.expires_at).toUTCString().replace(/ \d\d:\d\d:\d\d GMT/, "") : null;
  return publicShell(view.title, view.account_name, html`
    <main class="sign-wrap">
      <section class="card intro-card" aria-labelledby="intro-title">
        ${companyLogo(view.account_name, html`<img class="intro-icon" src="${asset("sign-icon.svg")}" alt="" width="48" height="48">`)}
        <p class="muted" style="margin-bottom:4px">${view.sender_name ? `${view.sender_name} at ${view.account_name}` : view.account_name} sent you a document to review and sign</p>
        <h1 id="intro-title">${view.title}</h1>
        <dl class="kv small" style="margin:14px 0 20px"><dt>For</dt><dd>${view.signer.name} (${view.signer.email})</dd>
          <dt>Fields</dt><dd>${view.fields.length} to complete</dd>
          ${view.progress.total > 1 ? html`<dt>Signers</dt><dd>${view.progress.signed} of ${view.progress.total} have signed</dd>` : ""}
          ${due ? html`<dt>Due</dt><dd>${due}</dd>` : ""}</dl>
        ${error ? alert("bad", error) : ""}
        <form method="post" action="/s/${token}/start" aria-label="Agree to sign electronically">
          <aside class="disclosure" aria-labelledby="disclosure-title"><strong id="disclosure-title">Electronic record and signature disclosure</strong><p>${view.consent_text}</p>
            <details><summary>Read the full disclosure</summary><pre class="disclosure-full">${view.disclosure}</pre></details></aside>
          <label class="check consent"><input type="checkbox" name="consent" required aria-describedby="disclosure-title"> <span>I agree to use electronic records and signatures.</span></label>
          <button type="submit" class="btn-go w-full">Continue</button>
        </form>
      </section>
      ${declineBlock(token)}
    </main>
    ${declineForm(token)}`);
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
  // data-smd-field, not data-field: Oat styles [data-field] as a form-field wrapper.
  const common = { dataSmdField: def.key, dataType: def.type, ...(required ? { dataRequired: "1", ariaRequired: "true" } : {}), title: label, ariaLabel: label };

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
        el("button", { type: "button", className: ["smd-sign-tag"], ariaLabel: `${def.type === "initials" ? "Initial" : "Sign"}: ${label}`, ariaHaspopup: "dialog" }, [text(def.type === "initials" ? "Initial" : "Sign")]),
        el("span", { className: ["smd-sign-value"], role: "button", tabIndex: 0, ariaLabel: `Change ${label}` }, done ? [kind === "drawn" ? el("img", { src: image, alt: label }) : el("span", { className: ["smd-signature-typed"] }, [text(typed)])] : []),
        el("input", { type: "hidden", name: `${name}:kind`, value: kind || "typed" }),
        el("input", { type: "hidden", name: `${name}:image`, value: image }),
        // Without JavaScript the signer types their name here.
        el("input", { type: "text", className: ["smd-sign-fallback"], name: `${name}:text`, value: typed, placeholder: def.type === "initials" ? "Type initials" : "Type full name", ariaLabel: label, autoComplete: "name" }),
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
      return el("span", { className: ["smd-slot", "smd-slot-other"], role: "note" }, [text(`${def.rules.label ?? fieldLabel(def)} – ${view.names[def.signer!] ?? def.signer}`)]);
    },
  });
  const required = view.fields.filter((f) => f.required).length;
  return publicShell(view.title, view.account_name, html`
    <form method="post" action="/s/${token}" id="sign-form" novalidate aria-label="Sign ${view.title}">
      <div class="guide-bar" role="toolbar" aria-label="Signing progress">
        ${logoVersion
          ? html`<img class="guide-logo" src="/branding/logo?v=${logoVersion}" alt="${view.account_name}">`
          : html`<img class="guide-logo guide-icon" src="${asset("sign-icon.svg")}" alt="" width="32" height="32">`}
        <p class="guide-info"><strong class="guide-title">${view.title}</strong><span class="small muted" id="guide-progress" role="status" aria-live="polite">${required} required field${required === 1 ? "" : "s"}</span></p>
        <div class="row">
          <button type="button" class="ghost" id="guide-back" hidden>Back</button>
          <button type="submit" class="btn-go" id="guide-next">Finish</button>
        </div>
      </div>
      <main class="sign-wrap">
        ${error ? html`<div role="alert" class="note" data-variant="error" id="sign-error" tabindex="-1">${icon("bad")}<div>${error.message}${error.issues.length ? html`<ul>${error.issues.map((i) => html`<li>${i.message}</li>`)}</ul>` : ""}</div></div>` : ""}
        <div class="sign-layout">
          <div class="sign-main">
          <p class="small muted guide-hint">Fill in the highlighted fields in the document. Use <strong>Next</strong> to jump between them, then <strong>Finish</strong>.</p>
            <article class="doc page signing ${CONTRACT_FONTS[view.font].css}" aria-label="${view.title}"><div class="page-body">${raw(docHtml)}</div></article>
          </div>
          ${progressPanel(view, token)}
        </div>
      </main>
    </form>
    ${declineForm(token)}

    <dialog id="adopt" closedby="any" aria-labelledby="adopt-title" aria-describedby="adopt-legal" data-name="${view.signer.name}" data-initials="${initials(view.signer.name)}">
      <header>
        <h2 id="adopt-title">Adopt your signature</h2>
        <p>Confirm your name and choose how your signature looks.</p>
      </header>
      <div class="adopt-body">
        <div class="sig-modes" role="group" aria-label="Signature style">
          <button type="button" class="small" data-mode="typed" aria-pressed="true">Type</button>
          <button type="button" class="outline small" data-mode="drawn" aria-pressed="false">Draw</button>
        </div>
        <div data-pane="typed">
          ${field("adopt-text", html`<span id="adopt-text-label">Full name</span>`, html`<input type="text" id="adopt-text" autocomplete="name" autofocus>`)}
          <p class="typed-preview" id="adopt-preview" aria-hidden="true"></p>
        </div>
        <div data-pane="drawn" hidden><div class="sig-pad-wrap"><canvas class="sig-pad" id="adopt-pad" role="img" aria-label="Draw your signature here, on the line"></canvas><span class="sig-line" aria-hidden="true"></span><button type="button" class="ghost small" id="adopt-clear">Clear</button></div></div>
        <p class="small muted" id="adopt-legal">By selecting Adopt and sign, I agree that this is my electronic signature for this document.</p>
      </div>
      <footer>
        <form method="dialog"><button value="cancel" class="outline">Cancel</button></form>
        <button type="button" class="btn-go" id="adopt-ok">Adopt and sign</button>
      </footer>
      <form method="dialog" class="dialog-close"><button value="cancel" class="ghost small icon" aria-label="Close">${icon("close")}</button></form>
    </dialog>`, { scripts: true, bodyClass: "signing-body", footer: false });
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
          if (pdf) extra = html`<a class="button" href="${downloadLink(ctx, pdf.id, 600).url}">Download signed PDF</a>`;
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
