import { type FieldDef, parseTemplate, renderHtml, SignedError } from "@signed-md/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { Actor, Ctx } from "../context.ts";
import { safeEqual } from "../crypto.ts";
import { WEBHOOK_EVENTS } from "../http/api.ts";
import { clientIp, rateLimit } from "../http/ratelimit.ts";
import { getAccount, isSetUp, newWebhookSecret, setup, updateAccount, type InlineDocumentsSetting } from "../services/accounts.ts";
import { changePassword, createApiKey, csrfToken, listApiKeys, login, logout, revokeApiKey, sessionActor } from "../services/auth.ts";
import * as docs from "../services/documents.ts";
import { listEvents } from "../services/events.ts";
import { listArtifacts } from "../services/finalize.ts";
import * as tpl from "../services/templates.ts";
import { listDeliveries } from "../services/webhooks.ts";
import { readLogo, removeLogo, setBannerAndAvatars, setDefaultMessage, setLogo } from "../services/branding.ts";
import { avatarOrigin, avatarUrl, initialsOf } from "../services/avatars.ts";
import { renderEmail } from "../services/emailtemplate.ts";
import { MESSAGE_VARIABLES, personalizeMessage } from "../services/messagevars.ts";
import { type FormBody, parseSigners, parseValues, signerRows, str, valueInput } from "./forms.ts";
import { badge, csrfInput, type H, issuesList, shell, when } from "./layout.ts";

type Env = { Variables: { user: Actor & { kind: "user" }; csrf: string; session: string } };

const COOKIE = "smd_session";

const MESSAGES: Record<string, ["ok" | "bad" | "warn" | "info", string]> = {
  sent: ["ok", "Sent. Signers in the first group have their links."],
  revoked: ["ok", "Revoked. Signing links no longer work."],
  archived: ["ok", "Archived."],
  unarchived: ["ok", "Restored from the archive."],
  resent: ["ok", "A new link was sent."],
  approved: ["ok", "Approved."],
  saved: ["ok", "Saved."],
  created: ["ok", "Created."],
  password: ["ok", "Password changed."],
  testmail: ["ok", "Test email sent."],
  logo: ["ok", "Logo updated."],
  nologo: ["ok", "Logo removed."],
};

const EXAMPLE_TEMPLATE = `---
fields:
  $fee:
    label: Monthly fee
    minimum: "100.00"
  $notice_days:
    allowed_values: [30, 60, 90]
    default: 30
---

# Service agreement

This agreement is between **Your Company** and {{$client_name:text}}.

## Fees

The client pays {{$fee:currency(USD)}} per month.

## Termination

Either party may end this agreement with {{$notice_days:number}} days' written notice.

## Signatures

Client: {{client.signature:signature}} Date: {{client.date:date}}

Provider: {{provider.signature:signature}}
`;

export function createAdmin(ctx: Ctx) {
  const app = new Hono<Env>();
  const secure = ctx.config.publicUrl.startsWith("https://");

  const flash = (c: Context) => {
    const m = MESSAGES[c.req.query("msg") ?? ""];
    return m ? { kind: m[0], text: m[1] } : null;
  };
  const page = (c: Context<Env>, title: string, active: string, body: H, extra?: { kind: "ok" | "bad" | "warn" | "info"; text: string } | null) =>
    c.html(shell({ title, user: { email: c.get("user").label }, csrf: c.get("csrf"), active, flash: extra ?? flash(c) }, body));

  // ---- Public: setup and login ----

  const loginLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (c) => `login:${clientIp(c)}` });

  app.get("/setup", async (c) => {
    if (await isSetUp(ctx)) return c.redirect("/login");
    return c.html(setupPage());
  });
  app.post("/setup", loginLimit, async (c) => {
    if (await isSetUp(ctx)) return c.redirect("/login");
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setup(ctx, { accountName: str(b, "account"), email: str(b, "email"), password: str(b, "password") });
      const s = await login(ctx, str(b, "email"), str(b, "password"));
      setCookie(c, COOKIE, s!.token, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: 14 * 86400 });
      return c.redirect("/documents?welcome=1");
    } catch (e) {
      return c.html(setupPage((e as Error).message, b), 400);
    }
  });

  app.get("/login", async (c) => {
    if (!(await isSetUp(ctx))) return c.redirect("/setup");
    return c.html(loginPage());
  });
  app.post("/login", loginLimit, async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const s = await login(ctx, str(b, "email"), str(b, "password"));
    if (!s) return c.html(loginPage("Email or password is not correct.", str(b, "email")), 401);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: 14 * 86400 });
    return c.redirect("/documents");
  });

  // ---- Session + CSRF for everything else ----

  const PUBLIC = ["/setup", "/login"];
  app.use("*", async (c, next) => {
    if (PUBLIC.includes(c.req.path)) return next();
    const token = getCookie(c, COOKIE);
    const user = await sessionActor(ctx, token);
    if (!user) {
      if (!(await isSetUp(ctx))) return c.redirect("/setup");
      return c.redirect(`/login`);
    }
    const csrf = csrfToken(ctx, token!);
    if (c.req.method === "POST") {
      const b = (await c.req.parseBody()) as FormBody;
      if (!safeEqual(str(b, "_csrf"), csrf)) return c.text("Invalid form token. Go back, reload the page, and try again.", 403);
    }
    c.set("user", user);
    c.set("csrf", csrf);
    c.set("session", token!);
    await next();
  });

  app.post("/logout", async (c) => {
    await logout(ctx, c.get("session"));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  app.get("/", (c) => c.redirect("/documents"));

  // ---- Documents ----

  app.get("/documents", async (c) => {
    const archived = c.req.query("archived") === "1";
    const status = c.req.query("status") || undefined;
    const q = c.req.query("q") || undefined;
    const list = await docs.listDocuments(ctx, { archived, ...(status ? { status } : {}), ...(q ? { q } : {}), limit: 100 });
    const avatarsOn = (await getAccount(ctx)).config.branding.avatars;
    const welcome = c.req.query("welcome") === "1";
    return page(
      c,
      "Documents",
      "documents",
      html`
      ${welcome ? html`<div class="notice info"><strong>Welcome to Signed.md.</strong> Next steps: create a template, then an API key in Settings so your agent can send agreements.</div>` : ""}
      <div class="page-head"><h1>Documents</h1><div class="row"><a class="btn primary" href="/documents/new">New document</a></div></div>
      <form class="row" method="get" style="margin-bottom:14px">
        <input type="text" name="q" value="${q ?? ""}" placeholder="Search title, signer name or email" style="max-width:320px">
        <select name="status" style="max-width:200px"><option value="">Any status</option>
          ${["draft", "sent", "partially_signed", "signed", "finalized", "declined", "expired", "revoked"].map((s) => html`<option value="${s}" ${s === status ? "selected" : ""}>${s.replace("_", " ")}</option>`)}
        </select>
        ${archived ? html`<input type="hidden" name="archived" value="1">` : ""}
        <button class="btn">Filter</button>
        <a href="${archived ? "/documents" : "/documents?archived=1"}" class="small">${archived ? "Back to active documents" : "View archive"}</a>
      </form>
      <div class="card table-wrap" style="padding:0">
      ${list.data.length === 0
        ? html`<div class="empty">${archived ? "Nothing archived." : html`No documents yet. <a href="/documents/new">Create one</a> or connect an agent.`}</div>`
        : html`<table class="list"><thead><tr><th>Title</th><th>Status</th><th>Signers</th><th>Created</th></tr></thead><tbody>
          ${list.data.map((d) => {
            const signed = d.signers.filter((s) => s.status === "signed").length;
            return html`<tr>
              <td><a href="/documents/${d.id}"><strong>${d.title}</strong></a><div class="small muted mono">${d.id}</div></td>
              <td>${badge(d.status)}</td>
              <td><div class="avatar-stack">${d.signers.map((s) => avatar(ctx, avatarsOn, s.name, s.email, "sm"))}</div><div class="small muted">${signed} of ${d.signers.length} signed</div></td>
              <td class="nowrap">${when(d.created_at)}</td></tr>`;
          })}
        </tbody></table>`}
      </div>`,
    );
  });

  app.get("/documents/new", async (c) => {
    const templateId = c.req.query("template");
    if (templateId) {
      const v = await tpl.resolveVersionForDocument(ctx, templateId).catch((e: Error) => e);
      if (v instanceof Error) return page(c, "New document", "documents", html`<div class="notice bad">${v.message}</div><a href="/documents/new">Back</a>`);
      const parsed = parseTemplate(v.source);
      return page(c, "New document", "documents", documentForm(c.get("csrf"), { mode: "template", templateId, templateName: v.template.name, version: v.version, fields: parsed.fields, signers: signerKeys(parsed.fields).map((key, i) => ({ key, name: "", email: "", order: i + 1 })), values: {} }));
    }
    if (c.req.query("inline") === "1") return page(c, "New document", "documents", inlineStart(c.get("csrf")));
    const templates = (await tpl.listTemplates(ctx)).filter((t) => t.approved_version !== null);
    const account = await getAccount(ctx);
    return page(
      c,
      "New document",
      "documents",
      html`<div class="page-head"><h1>New document</h1></div>
      <div class="card"><h2>Start from an approved template</h2>
        ${templates.length === 0
          ? html`<p class="muted">No approved templates yet. <a href="/templates/new">Create a template</a>.</p>`
          : html`<table class="list"><tbody>${templates.map((t) => html`<tr><td><strong>${t.name}</strong><div class="small muted">${t.description}</div></td><td class="nowrap">v${t.approved_version}</td><td style="text-align:right"><a class="btn small" href="/documents/new?template=${t.id}">Use</a></td></tr>`)}</tbody></table>`}
      </div>
      ${account.config.inline_documents !== "disabled"
        ? html`<div class="card"><h2>Or write it now</h2><p class="muted">Paste Markdown with placeholders. No approved template protects inline legal language.</p><a class="btn" href="/documents/new?inline=1">Write inline Markdown</a></div>`
        : ""}`,
    );
  });

  // Inline step 1 → step 2: parse the content to find values and signers.
  app.post("/documents/new/inline", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const content = str(b, "content");
    const parsed = parseTemplate(content);
    if (parsed.issues.length) return page(c, "New document", "documents", html`<div class="notice bad">The Markdown has problems:${issuesList(parsed.issues)}</div>${inlineStart(c.get("csrf"), content)}`);
    return page(c, "New document", "documents", documentForm(c.get("csrf"), { mode: "inline", content, fields: parsed.fields, signers: signerKeys(parsed.fields).map((key, i) => ({ key, name: "", email: "", order: i + 1 })), values: {} }));
  });

  app.post("/documents", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const templateId = str(b, "template_id") || undefined;
    const content = templateId ? undefined : str(b, "content");
    const source = templateId ? (await tpl.resolveVersionForDocument(ctx, templateId)).source : content!;
    const fields = parseTemplate(source).fields;
    const signers = parseSigners(b);
    const values = parseValues(b, fields);
    try {
      const d = await docs.createDocument(ctx, c.get("user"), {
        ...(templateId ? { template_id: templateId } : { content: content! }),
        values,
        signers,
        ...(str(b, "title") ? { title: str(b, "title") } : {}),
        ...(str(b, "expires_in_days") ? { expires_in_days: Number(str(b, "expires_in_days")) } : {}),
      });
      return c.redirect(`/documents/${d.id}?msg=created`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "New document", "documents", html`<div class="notice bad">${e.message}${e.issues.length ? issuesList(e.issues) : ""}</div>
        ${documentForm(c.get("csrf"), { mode: templateId ? "template" : "inline", ...(templateId ? { templateId } : { content: content! }), fields, signers, values, title: str(b, "title") })}`);
    }
  });

  app.get("/documents/:id", async (c) => {
    const id = c.req.param("id");
    const d = await docs.getDocument(ctx, id);
    const account = await getAccount(ctx);
    const events = await listEvents(ctx.db, id);
    const preview = d.status === "draft" ? await docs.previewDocument(ctx, id) : null;
    const artifacts = d.status === "finalized" ? await listArtifacts(ctx, id, 300) : [];
    const docHtml = preview ? preview.html : await completedHtml(ctx, id);
    const csrf = c.get("csrf");
    const active = d.status === "sent" || d.status === "partially_signed";
    const inlineNeedsApproval = d.inline_approval?.required && !d.inline_approval.approved;
    return page(
      c,
      d.title,
      "documents",
      html`<div class="page-head"><div><h1>${d.title}</h1><div class="row small muted"><span class="mono">${d.id}</span> ${badge(d.status)} ${d.archived ? badge("archived") : ""} ${d.source === "inline" ? html`<span class="badge warn">inline</span>` : ""}</div></div>
        <div class="row">
          ${d.status === "draft" ? html`<a class="btn" href="/documents/${d.id}/edit">Edit</a>` : ""}
          <form method="post" action="/documents/${d.id}/${d.archived ? "unarchive" : "archive"}" class="inline">${csrfInput(csrf)}<button class="btn">${d.archived ? "Unarchive" : "Archive"}</button></form>
        </div></div>
      <div class="grid">
        <div>
          ${preview && preview.errors.length ? html`<div class="notice bad"><strong>Not ready to send.</strong>${issuesList(preview.errors)}</div>` : ""}
          <article class="doc">${raw(docHtml)}</article>
        </div>
        <aside>
          ${d.status === "draft" ? html`<div class="card"><h2>Send</h2>
            ${preview!.valid
              ? inlineNeedsApproval
                ? html`<p>This account requires a person to approve inline documents.</p>
                  <form method="post" action="/documents/${d.id}/approve-inline">${csrfInput(csrf)}<input type="hidden" name="revision" value="${preview!.revision}"><button class="btn block">Approve this revision</button></form>`
                : html`<p class="small muted">You are approving revision <code>${preview!.revision.slice(0, 16)}…</code>. Any edit needs a new approval.</p>
                  <form method="post" action="/documents/${d.id}/send" data-confirm="Send this document for signature now?">${csrfInput(csrf)}
                    <input type="hidden" name="approved_revision" value="${preview!.revision}">
                    <div class="field"><label>Message to signers <span class="muted">· optional</span></label><textarea name="message" style="min-height:90px" maxlength="2000" placeholder="Shown in the signing email">${account.config.branding.email_message}</textarea>${variablesHint()}</div>
                    <div class="field"><label>Approved by</label><input type="text" name="approved_by" value="${c.get("user").label}"></div>
                    <button class="btn primary block">Send for signature</button></form>`
              : html`<p class="muted">Fix the errors, then send.</p>`}
          </div>` : ""}
          ${artifacts.length ? html`<div class="card"><h2>Completed package</h2><div class="stack">
            ${artifacts.map((a) => html`<a class="btn block" href="${a.download.url}">${a.type === "zip" ? "Download package (.zip)" : "Download signed PDF"}</a>`)}
            <p class="small muted">Verify the package offline with <code>npx signed-md verify file.zip</code>.</p></div></div>` : ""}
          <div class="card"><h2>Signers</h2>
            ${d.signers.map((s) => html`<div class="signer-item"><div class="spread"><div class="row" style="gap:10px;flex-wrap:nowrap">${avatar(ctx, account.config.branding.avatars, s.name, s.email)}<strong>${s.name}</strong></div>${badge(s.status)}</div>
              <div class="small muted" style="margin-left:46px">${s.email} · <code>${s.key}</code> · order ${s.order}</div>
              ${s.decline_reason ? html`<div class="small">Reason: “${s.decline_reason}”</div>` : ""}
              ${active && (s.status === "notified" || s.status === "viewed") ? html`<form method="post" action="/documents/${d.id}/signers/${s.key}/resend" class="inline">${csrfInput(csrf)}<button class="btn small" style="margin-top:6px">Resend link</button></form>` : ""}
            </div>`)}
          </div>
          <div class="card"><h2>Details</h2><dl class="kv small">
            <dt>Source</dt><dd>${d.template ? html`<a href="/templates/${d.template.id}">template v${d.template.version}</a>` : "inline"}</dd>
            <dt>Revision</dt><dd class="mono">${d.revision.slice(0, 20)}…</dd>
            ${d.approved_by ? html`<dt>Approved by</dt><dd>${d.approved_by}</dd>` : ""}
            ${d.message ? html`<dt>Message</dt><dd>${d.message}</dd>` : ""}
            <dt>Created</dt><dd>${when(d.created_at)}</dd>
            ${d.sent_at ? html`<dt>Sent</dt><dd>${when(d.sent_at)}</dd>` : ""}
            ${d.expires_at ? html`<dt>Expires</dt><dd>${when(d.expires_at)}</dd>` : html`<dt>Expires</dt><dd>${d.expires_in_days} days after sending</dd>`}
            ${d.completed_at ? html`<dt>Signed</dt><dd>${when(d.completed_at)}</dd>` : ""}
            ${d.revoked_at ? html`<dt>Revoked</dt><dd>${when(d.revoked_at)}${d.revoke_reason ? html` – ${d.revoke_reason}` : ""}</dd>` : ""}
            ${Object.keys(d.metadata).length ? html`<dt>Metadata</dt><dd class="mono">${JSON.stringify(d.metadata)}</dd>` : ""}
          </dl></div>
          ${active ? html`<div class="card"><h2>Revoke</h2><p class="small muted">Signing links stop working at once. To fix a mistake, revoke and create a new document.</p>
            <form method="post" action="/documents/${d.id}/revoke" data-confirm="Revoke this document? This cannot be undone.">${csrfInput(csrf)}
            <div class="field"><input type="text" name="reason" placeholder="Reason (optional)"></div><button class="btn danger block">Revoke</button></form></div>` : ""}
          <div class="card"><h2>Evidence log</h2><ul class="timeline">
            ${events.map((e) => html`<li><strong>${e.type}</strong> <span class="muted">· ${e.actor_label}</span><div class="muted small">${when(e.created_at)}</div></li>`)}
          </ul></div>
        </aside>
      </div>`,
      account.config.inline_documents === "needs_approval" && inlineNeedsApproval ? { kind: "warn", text: "This inline document needs approval before it can be sent." } : undefined,
    );
  });

  app.get("/documents/:id/edit", async (c) => {
    const id = c.req.param("id");
    const d = await docs.getDocument(ctx, id);
    if (d.status !== "draft") return c.redirect(`/documents/${id}`);
    const row = await docs.loadDocument(ctx.db, id);
    const fields = parseTemplate(row.source).fields;
    return page(c, `Edit ${d.title}`, "documents", documentForm(c.get("csrf"), {
      mode: d.source, editId: id, ...(d.source === "inline" ? { content: row.source } : { templateId: d.template!.id }),
      fields, values: d.values, signers: d.signers.map((s) => ({ key: s.key, name: s.name, email: s.email, order: s.order })), title: d.title,
      expires: d.expires_in_days,
    }));
  });

  app.post("/documents/:id/edit", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.parseBody()) as FormBody;
    const row = await docs.loadDocument(ctx.db, id);
    const content = row.source_kind === "inline" ? str(b, "content") : undefined;
    const fields = parseTemplate(content ?? row.source).fields;
    const signers = parseSigners(b);
    const existing = await docs.loadSigners(ctx.db, id);
    try {
      await docs.updateDocument(ctx, c.get("user"), id, {
        values: { ...Object.fromEntries(Object.keys(JSON.parse(row.values_json)).map((k) => [k, null])), ...parseValues(b, fields) },
        signers,
        remove_signers: existing.map((s) => s.key).filter((k) => !signers.some((s) => s.key === k)),
        ...(content !== undefined ? { content } : {}),
        ...(str(b, "title") ? { title: str(b, "title") } : {}),
        ...(str(b, "expires_in_days") ? { expires_in_days: Number(str(b, "expires_in_days")) } : {}),
      });
      return c.redirect(`/documents/${id}?msg=saved`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Edit", "documents", html`<div class="notice bad">${e.message}${issuesList(e.issues)}</div>`);
    }
  });

  const action = (path: string, fn: (c: Context<Env>, b: FormBody) => Promise<string>) =>
    app.post(path, async (c) => {
      const b = (await c.req.parseBody()) as FormBody;
      try {
        return c.redirect(await fn(c, b));
      } catch (e) {
        if (!(e instanceof SignedError)) throw e;
        const back = c.req.path.split("/").slice(0, 3).join("/");
        return page(c, "Error", "documents", html`<div class="notice bad">${e.message}${e.issues.length ? issuesList(e.issues) : ""}</div><a class="btn" href="${back}">Back</a>`);
      }
    });

  action("/documents/:id/send", async (c, b) => {
    const id = c.req.param("id")!;
    await docs.sendDocument(ctx, c.get("user"), id, { approved_revision: str(b, "approved_revision"), approved_by: str(b, "approved_by") || c.get("user").label, message: str(b, "message") });
    return `/documents/${id}?msg=sent`;
  });
  action("/documents/:id/approve-inline", async (c, b) => {
    const id = c.req.param("id")!;
    await docs.approveInlineDocument(ctx, c.get("user"), id, str(b, "revision"));
    return `/documents/${id}?msg=approved`;
  });
  action("/documents/:id/revoke", async (c, b) => {
    const id = c.req.param("id")!;
    await docs.revokeDocument(ctx, c.get("user"), id, str(b, "reason") || undefined);
    return `/documents/${id}?msg=revoked`;
  });
  action("/documents/:id/archive", async (c) => {
    await docs.setDocumentArchived(ctx, c.get("user"), c.req.param("id")!, true);
    return `/documents/${c.req.param("id")}?msg=archived`;
  });
  action("/documents/:id/unarchive", async (c) => {
    await docs.setDocumentArchived(ctx, c.get("user"), c.req.param("id")!, false);
    return `/documents/${c.req.param("id")}?msg=unarchived`;
  });
  action("/documents/:id/signers/:key/resend", async (c) => {
    await docs.resendToSigner(ctx, c.get("user"), c.req.param("id")!, c.req.param("key")!);
    return `/documents/${c.req.param("id")}?msg=resent`;
  });

  // ---- Templates ----

  app.get("/templates", async (c) => {
    const archived = c.req.query("archived") === "1";
    const list = await tpl.listTemplates(ctx, { archived });
    const pending = list.filter((t) => t.versions.some((v) => v.approval_status === "pending_approval"));
    return page(c, "Templates", "templates", html`
      <div class="page-head"><h1>Templates</h1><a class="btn primary" href="/templates/new">New template</a></div>
      ${pending.length && !archived ? html`<div class="notice warn"><strong>${pending.length} template${pending.length > 1 ? "s" : ""} waiting for approval.</strong> Agents can draft templates, but only you can approve them.</div>` : ""}
      <div class="card table-wrap" style="padding:0">
      ${list.length === 0 ? html`<div class="empty">${archived ? "Nothing archived." : html`No templates yet. <a href="/templates/new">Create your first template</a>.`}</div>`
        : html`<table class="list"><thead><tr><th>Name</th><th>Approved</th><th>Latest</th><th>Created via</th></tr></thead><tbody>
          ${list.map((t) => html`<tr><td><a href="/templates/${t.id}"><strong>${t.name}</strong></a><div class="small muted">${t.description}</div></td>
            <td>${t.approved_version ? html`v${t.approved_version}` : html`<span class="muted">none</span>`}</td>
            <td>v${t.current_version} ${badge(t.versions[0]!.approval_status)}</td>
            <td>${t.created_via === "ui" ? "UI" : html`<span class="badge warn">${t.created_via.toUpperCase()}</span>`}</td></tr>`)}
        </tbody></table>`}
      </div>
      <a class="small" href="${archived ? "/templates" : "/templates?archived=1"}">${archived ? "Back to active templates" : "View archive"}</a>`);
  });

  app.get("/templates/new", (c) => page(c, "New template", "templates", templateForm(c.get("csrf"), { name: "", description: "", source: EXAMPLE_TEMPLATE })));

  app.post("/templates", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const input = { name: str(b, "name"), description: str(b, "description"), source: str(b, "source").replace(/\r\n/g, "\n") };
    try {
      const t = await tpl.createTemplate(ctx, c.get("user"), { ...input, approve: str(b, "approve") === "1" });
      return c.redirect(`/templates/${t.id}?msg=created`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "New template", "templates", html`<div class="notice bad">${e.message}${issuesList(e.issues)}</div>${templateForm(c.get("csrf"), input)}`);
    }
  });

  app.get("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const t = await tpl.getTemplate(ctx, id);
    const shown = Number(c.req.query("v")) || t.current_version;
    const v = await tpl.getTemplateVersion(ctx, id, shown);
    const csrf = c.get("csrf");
    const body = v.source.replace(/^---\n[\s\S]*?\n---\n/, "");
    const names = await actorNames(ctx, t.versions.flatMap((x) => [x.created_by, x.approved_by ?? ""]));
    return page(c, t.name, "templates", html`
      <div class="page-head"><div><h1>${t.name}</h1><div class="small muted">${t.description}</div></div>
        <div class="row">
          ${t.approved_version ? html`<a class="btn primary" href="/documents/new?template=${t.id}">Use template</a>` : ""}
          <a class="btn" href="/templates/${t.id}/edit">New version</a>
          <form method="post" action="/templates/${t.id}/${t.archived ? "unarchive" : "archive"}" class="inline">${csrfInput(csrf)}<button class="btn">${t.archived ? "Unarchive" : "Archive"}</button></form>
        </div></div>
      ${v.approval_status === "pending_approval" ? html`<div class="notice warn"><div class="spread"><div><strong>Version ${v.version} is waiting for approval.</strong> Created by <strong>${names.get(v.created_by) ?? v.created_by}</strong>. Read it carefully: once approved, agents can send it.</div>
        <form method="post" action="/templates/${t.id}/versions/${v.version}/approve" data-confirm="Approve version ${v.version}? Agents will be able to send it.">${csrfInput(csrf)}<button class="btn primary">Approve version ${v.version}</button></form></div></div>` : ""}
      <div class="grid">
        <div>
          <article class="doc">${raw(renderHtml(body, {
            fields: v.fields,
            valueSlots: true,
            renderField: (f) => ({
              type: "element",
              tagName: "span",
              properties: { className: ["smd-field", f.kind === "value" ? "smd-field-value" : "smd-field-signer"] },
              children: [{ type: "text", value: f.kind === "value" ? `${f.rules.label ?? f.name}` : `${f.rules.label ?? f.key.split(".")[1]!.replace(/_/g, " ")} – ${f.signer}` }],
            }),
          }))}</article>
          <details class="card" style="margin-top:16px"><summary>Markdown source</summary><pre>${v.source}</pre></details>
        </div>
        <aside>
          <div class="card"><h2>Fields</h2>
            ${v.fields.map((f) => html`<div class="small" style="margin-bottom:6px"><code>${f.key}</code> <span class="muted">${f.type}${f.param ? `(${f.param})` : ""}</span>
              ${Object.keys(f.rules).length ? html`<div class="muted mono" style="font-size:.75rem">${JSON.stringify(f.rules)}</div>` : ""}</div>`)}
          </div>
          <div class="card"><h2>Versions</h2>
            ${t.versions.map((x) => html`<div class="spread" style="margin-bottom:8px"><a href="/templates/${t.id}?v=${x.version}">${x.version === shown ? html`<strong>v${x.version}</strong>` : `v${x.version}`}</a>${badge(x.approval_status)}</div>
              <div class="small muted" style="margin:-6px 0 10px">${when(x.created_at)} · ${names.get(x.created_by) ?? x.created_by}${x.approved_by ? html`<br>Approved by ${names.get(x.approved_by) ?? x.approved_by}` : ""}</div>`)}
          </div>
        </aside>
      </div>`);
  });

  app.get("/templates/:id/edit", async (c) => {
    const id = c.req.param("id");
    const t = await tpl.getTemplate(ctx, id);
    const v = await tpl.getTemplateVersion(ctx, id);
    return page(c, `Edit ${t.name}`, "templates", templateForm(c.get("csrf"), { id, name: t.name, description: t.description, source: v.source }));
  });

  app.post("/templates/:id/edit", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.parseBody()) as FormBody;
    const input = { name: str(b, "name"), description: str(b, "description"), source: str(b, "source").replace(/\r\n/g, "\n") };
    try {
      await tpl.addTemplateVersion(ctx, c.get("user"), id, { ...input, approve: str(b, "approve") === "1" });
      return c.redirect(`/templates/${id}?msg=saved`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Edit template", "templates", html`<div class="notice bad">${e.message}${issuesList(e.issues)}</div>${templateForm(c.get("csrf"), { id, ...input })}`);
    }
  });

  app.post("/templates/:id/versions/:v/approve", async (c) => {
    const id = c.req.param("id");
    await tpl.approveTemplateVersion(ctx, c.get("user"), id, Number(c.req.param("v")));
    return c.redirect(`/templates/${id}?v=${c.req.param("v")}&msg=approved`);
  });
  app.post("/templates/:id/archive", async (c) => {
    await tpl.setTemplateArchived(ctx, c.req.param("id"), true);
    return c.redirect(`/templates/${c.req.param("id")}?msg=archived`);
  });
  app.post("/templates/:id/unarchive", async (c) => {
    await tpl.setTemplateArchived(ctx, c.req.param("id"), false);
    return c.redirect(`/templates/${c.req.param("id")}?msg=unarchived`);
  });

  // ---- Settings ----

  app.get("/settings", async (c) => {
    const account = await getAccount(ctx);
    const keys = await listApiKeys(ctx);
    const deliveries = await listDeliveries(ctx, 10);
    const smtp = account.config.smtp;
    const envSmtp = ctx.config.smtp;
    const csrf = c.get("csrf");
    const newKey = c.req.query("key");
    return page(c, "Settings", "settings", html`
      <div class="page-head"><h1>Settings</h1></div>
      ${settingsTabs("general")}
      ${newKey ? html`<div class="notice ok"><strong>New API key.</strong> Copy it now. It will not be shown again.<pre>${newKey}</pre><button class="btn small" data-copy="${newKey}">Copy</button></div>` : ""}

      <div class="card"><h2>Connect an agent</h2>
        <p>Create an API key, then connect your agent over MCP or REST.</p>
        <dl class="kv small"><dt>MCP endpoint</dt><dd class="mono">${ctx.config.publicUrl}/mcp</dd>
          <dt>REST API</dt><dd class="mono">${ctx.config.publicUrl}/v1</dd>
          <dt>OpenAPI</dt><dd><a href="/openapi.json">/openapi.json</a></dd></dl>
        <pre>claude mcp add --transport http signed-md ${ctx.config.publicUrl}/mcp --header "Authorization: Bearer YOUR_API_KEY"</pre>
      </div>

      <div class="card"><h2>API keys</h2>
        ${keys.length ? html`<div class="table-wrap"><table class="list"><thead><tr><th>Label</th><th>Key</th><th>Last used</th><th></th></tr></thead><tbody>
          ${keys.map((k) => html`<tr><td>${k.label}</td><td class="mono">${k.prefix}…</td><td>${when(k.last_used_at)}</td>
            <td style="text-align:right">${k.revoked_at ? badge("revoked") : html`<form method="post" action="/settings/keys/${k.id}/revoke" data-confirm="Revoke this key? Agents using it will stop working.">${csrfInput(csrf)}<button class="btn small danger">Revoke</button></form>`}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No API keys yet.</p>`}
        <form method="post" action="/settings/keys" class="row" style="margin-top:12px">${csrfInput(csrf)}<input type="text" name="label" placeholder="Label, e.g. Sales agent" style="max-width:280px"><button class="btn">Create API key</button></form>
      </div>

      <form method="post" action="/settings/account" class="card">${csrfInput(csrf)}<h2>Account</h2>
        <div class="field"><label>Company name</label><input type="text" name="name" value="${account.name}"></div>
        <div class="field"><label>Inline documents <span class="muted">· documents written without an approved template</span></label>
          <select name="inline_documents">${(["allowed", "needs_approval", "disabled"] as const).map((o) => html`<option value="${o}" ${account.config.inline_documents === o ? "selected" : ""}>${{ allowed: "Allowed", needs_approval: "Need approval in the UI", disabled: "Disabled" }[o]}</option>`)}</select></div>
        <div class="inline-fields" style="grid-template-columns:1fr 1fr 1fr">
          <div class="field"><label>Default expiry (days)</label><input type="number" min="1" max="365" name="default_expiry_days" value="${account.config.default_expiry_days}"></div>
          <div class="field"><label>Timezone</label><input type="text" name="timezone" value="${account.config.timezone}"></div>
          <div class="field"><label>Locale</label><input type="text" name="locale" value="${account.config.locale}"></div>
        </div>
        <label class="check"><input type="checkbox" name="attach_zip" ${account.config.attach_zip ? "checked" : ""}> Attach the evidence ZIP to completion emails (the PDF is always attached)</label>
        <button class="btn primary" style="margin-top:12px">Save</button>
      </form>

      <form method="post" action="/settings/webhook" class="card">${csrfInput(csrf)}<h2>Webhook</h2>
        <p class="small muted">Events: ${WEBHOOK_EVENTS.join(", ")}. Requests are signed with HMAC-SHA256 in the <code>Signed-Md-Signature</code> header.</p>
        <div class="field"><label>URL</label><input type="url" name="url" value="${account.config.webhook_url ?? ""}" placeholder="https://example.com/hooks/signed"></div>
        <div class="field"><label>Signing secret</label><div class="row"><code>${account.config.webhook_secret}</code> <label class="check" style="margin:0"><input type="checkbox" name="rotate"> Rotate</label></div></div>
        <button class="btn primary">Save</button>
        ${deliveries.length ? html`<h3 style="margin-top:18px">Recent deliveries</h3><div class="table-wrap"><table class="list small"><tbody>${deliveries.map((d) => html`<tr><td>${d.event_type}</td><td>${badge(d.status)}</td><td>${d.last_status_code ?? ""} ${d.last_error ? html`<span class="muted">${d.last_error.slice(0, 80)}</span>` : ""}</td><td class="nowrap">${when(d.created_at)}</td></tr>`)}</tbody></table></div>` : ""}
      </form>

      <form method="post" action="/settings/smtp" class="card">${csrfInput(csrf)}<h2>Email (SMTP)</h2>
        ${!smtp?.host && !envSmtp ? html`<div class="notice warn">No SMTP server is set. Emails go to the <a href="/outbox">Outbox</a> so you can test without one.</div>` : ""}
        ${envSmtp && !smtp?.host ? html`<p class="small muted">Using SMTP from environment variables (${envSmtp.host}). Settings saved here take precedence.</p>` : ""}
        <div class="inline-fields" style="grid-template-columns:2fr 1fr"><div class="field"><label>Host</label><input type="text" name="host" value="${smtp?.host ?? ""}"></div>
          <div class="field"><label>Port</label><input type="number" name="port" value="${smtp?.port ?? 587}"></div></div>
        <div class="inline-fields" style="grid-template-columns:1fr 1fr"><div class="field"><label>Username</label><input type="text" name="user" value="${smtp?.user ?? ""}" autocomplete="off"></div>
          <div class="field"><label>Password <span class="muted">· leave empty to keep</span></label><input type="password" name="pass" autocomplete="new-password"></div></div>
        <div class="field"><label>From</label><input type="text" name="from" value="${smtp?.from ?? ""}" placeholder="Acme Contracts <contracts@acme.com>"></div>
        <label class="check"><input type="checkbox" name="secure" ${smtp?.secure ? "checked" : ""}> Use TLS from the start (port 465)</label>
        <div class="row" style="margin-top:12px"><button class="btn primary" name="do" value="save">Save</button><button class="btn" name="do" value="test">Save and send test email</button></div>
      </form>

      <form method="post" action="/settings/password" class="card">${csrfInput(csrf)}<h2>Password</h2>
        <div class="field"><label>New password <span class="muted">· at least 10 characters</span></label><input type="password" name="password" autocomplete="new-password"></div>
        <button class="btn">Change password</button></form>

      <div class="card"><h2>Signing key</h2><p class="small muted">Completed packages are signed with this key. Back up <code>${ctx.config.dataDir}/keys</code> together with the database.</p>
        <dl class="kv small"><dt>Key ID</dt><dd class="mono">${ctx.keys.info.kid}</dd><dt>Public keys</dt><dd><a href="/.well-known/signed-md-keys.json">/.well-known/signed-md-keys.json</a></dd></dl></div>`);
  });

  app.post("/settings/keys", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const { key } = await createApiKey(ctx, c.get("user"), str(b, "label"));
    return c.redirect(`/settings?key=${encodeURIComponent(key)}`);
  });
  app.post("/settings/keys/:id/revoke", async (c) => {
    await revokeApiKey(ctx, c.req.param("id"));
    return c.redirect("/settings?msg=saved");
  });
  app.post("/settings/account", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await updateAccount(ctx, {
        name: str(b, "name"),
        config: {
          inline_documents: str(b, "inline_documents") as InlineDocumentsSetting,
          default_expiry_days: Number(str(b, "default_expiry_days")),
          timezone: str(b, "timezone").trim() || "UTC",
          locale: str(b, "locale").trim() || "en-US",
          attach_zip: str(b, "attach_zip") === "on",
        },
      });
      return c.redirect("/settings?msg=saved");
    } catch (e) {
      return page(c, "Settings", "settings", html`<div class="notice bad">${(e as Error).message}</div><a class="btn" href="/settings">Back</a>`);
    }
  });
  app.post("/settings/webhook", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await updateAccount(ctx, { config: { webhook_url: str(b, "url").trim() || null, ...(str(b, "rotate") === "on" ? { webhook_secret: newWebhookSecret() } : {}) } });
      return c.redirect("/settings?msg=saved");
    } catch (e) {
      return page(c, "Settings", "settings", html`<div class="notice bad">${(e as Error).message}</div><a class="btn" href="/settings">Back</a>`);
    }
  });
  app.post("/settings/smtp", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const account = await getAccount(ctx);
    const host = str(b, "host").trim();
    const smtp = host
      ? {
          host,
          port: Number(str(b, "port")) || 587,
          secure: str(b, "secure") === "on",
          from: str(b, "from").trim() || `Signed.md <no-reply@${new URL(ctx.config.publicUrl).hostname}>`,
          ...(str(b, "user") ? { user: str(b, "user") } : {}),
          ...(str(b, "pass") ? { pass: str(b, "pass") } : account.config.smtp?.pass ? { pass: account.config.smtp.pass } : {}),
        }
      : null;
    await updateAccount(ctx, { config: { smtp } });
    if (str(b, "do") === "test") {
      try {
        const acct = await getAccount(ctx);
        const t = renderEmail({ account: acct.name, hasLogo: false, icon: "check", headline: "SMTP works. Signed.md can send email.", paragraphs: ["This is a test email from your Signed.md settings."] });
        await ctx.mailer.send({ to: c.get("user").label, subject: "Signed.md test email", text: t.text, html: t.html }, smtp);
        return c.redirect("/settings?msg=testmail");
      } catch (e) {
        return page(c, "Settings", "settings", html`<div class="notice bad">Saved, but the test email failed: ${(e as Error).message}</div><a class="btn" href="/settings">Back</a>`);
      }
    }
    return c.redirect("/settings?msg=saved");
  });
  app.post("/settings/password", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await changePassword(ctx, c.get("user").id, str(b, "password"));
      return c.redirect("/settings?msg=password");
    } catch (e) {
      return page(c, "Settings", "settings", html`<div class="notice bad">${(e as Error).message}</div><a class="btn" href="/settings">Back</a>`);
    }
  });

  // ---- Branding ----

  app.get("/settings/branding", async (c) => {
    const account = await getAccount(ctx);
    const logo = account.config.branding.logo;
    const csrf = c.get("csrf");
    return page(c, "Branding", "settings", html`
      <div class="page-head"><h1>Settings</h1></div>
      ${settingsTabs("branding")}
      <div style="max-width:720px">
        <div>
          <form method="post" action="/settings/branding/logo" enctype="multipart/form-data" class="card">${csrfInput(csrf)}
            <h2>Logo</h2>
            <p class="small muted">Shown at the top of every email and on the signing pages. PNG or JPEG, up to 300 KB. A wide logo about 400 × 80 pixels works best.</p>
            ${logo ? html`<div class="logo-preview"><img src="/branding/logo?v=${logo.sha256.slice(0, 8)}" alt="Current logo"></div>` : html`<p class="muted">No logo. Emails show “${account.name}” instead.</p>`}
            <div class="row" style="margin-top:12px"><input type="file" name="logo" accept="image/png,image/jpeg" style="max-width:280px"><button class="btn primary">Upload</button></div>
          </form>
          ${logo ? html`<form method="post" action="/settings/branding/logo/remove" class="inline" style="display:block;margin:-6px 0 18px">${csrfInput(csrf)}<button class="btn small">Remove logo</button></form>` : ""}
          <form method="post" action="/settings/branding/look" class="card">${csrfInput(csrf)}
            <h2>Email banner and avatars</h2>
            <div class="field"><label for="banner_color">Banner colour</label>
              <div class="row"><input type="color" id="banner_color_picker" value="${account.config.branding.banner_color}" data-sync="banner_color" style="width:52px;height:38px;padding:2px">
              <input type="text" id="banner_color" name="banner_color" value="${account.config.branding.banner_color}" pattern="#[0-9a-fA-F]{6}" style="max-width:130px" class="mono"></div>
              <p class="small muted" style="margin:6px 0 0">Text and button colours adjust automatically for contrast.</p></div>
            <label class="check"><input type="checkbox" name="avatars" ${account.config.branding.avatars ? "checked" : ""}> <span>Show avatars in emails and in this app<br><span class="small muted">Pictures come from unavatar.io${ctx.config.avatarBaseUrl !== "https://unavatar.io" ? html` through <code>${ctx.config.avatarBaseUrl}</code>` : ""}. This shares email addresses with that service, and email clients load the pictures from it. Without a picture, initials are shown.</span></span></label>
            <button class="btn primary" style="margin-top:12px">Save</button>
          </form>
          <form method="post" action="/settings/branding/message" class="card">${csrfInput(csrf)}
            <h2>Message to signers</h2>
            <p class="small muted">The default message in every signing email. You can change it each time you send. Agents can pass their own message too.</p>
            <div class="field"><textarea name="message" maxlength="2000" placeholder="e.g. Hi {{recipient.first_name}}, please review and sign {{document.title}}. Reply to this email with any questions.">${account.config.branding.email_message}</textarea></div>
            ${variablesHint()}
            <button class="btn primary">Save</button>
          </form>
        </div>
        <div class="card"><h2>Preview</h2><p class="small muted">The email a signer receives.</p>
          <iframe class="email-frame" src="/settings/branding/preview" title="Email preview"></iframe></div>
      </div>`);
  });

  app.get("/settings/branding/preview", async (c) => {
    const account = await getAccount(ctx);
    const logo = await readLogo(ctx);
    const { html: body } = renderEmail({
      account: account.name,
      hasLogo: logo !== null,
      bannerColor: account.config.branding.banner_color,
      icon: "document",
      person: { name: account.name, avatar: avatarUrl(ctx.config, account.config.branding.avatars, c.get("user").label), initials: initialsOf(account.name) },
      signers: [
        { name: "Jane Doe", avatar: avatarUrl(ctx.config, account.config.branding.avatars, "jane@acme.example"), initials: "JD" },
        { name: "Sam Lee", avatar: avatarUrl(ctx.config, account.config.branding.avatars, "sam@automaze.example"), initials: "SL" },
      ],
      headline: `${account.name} sent you a document to review and sign.`,
      button: { label: "Review document", url: "#" },
      from: { name: account.name, email: c.get("user").label },
      message: account.config.branding.email_message
        ? personalizeMessage(account.config.branding.email_message, { name: "Jane Doe", email: "jane@acme.example", title: "Standard services agreement" })
        : null,
      paragraphs: account.config.branding.email_message ? [] : ['Hi Jane Doe, please review and sign "Standard services agreement". It takes a few minutes and works on your phone.'],
      details: [["Document", "Standard services agreement"]],
      security: true,
    });
    return emailPage(c, logo ? body.split("cid:logo@signed.md").join(`data:${logo.contentType};base64,${logo.data.toString("base64")}`) : body, avatarOrigin(ctx.config));
  });

  app.post("/settings/branding/logo", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const file = b.logo;
    try {
      if (!(file instanceof File)) throw new SignedError("INVALID_REQUEST", "Choose a logo file to upload");
      await setLogo(ctx, new Uint8Array(await file.arrayBuffer()));
      return c.redirect("/settings/branding?msg=logo");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`<div class="notice bad">${e.message}</div><a class="btn" href="/settings/branding">Back</a>`);
    }
  });
  app.post("/settings/branding/look", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setBannerAndAvatars(ctx, { banner_color: str(b, "banner_color"), avatars: str(b, "avatars") === "on" });
      return c.redirect("/settings/branding?msg=saved");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`<div class="notice bad">${e.message}</div><a class="btn" href="/settings/branding">Back</a>`);
    }
  });
  app.post("/settings/branding/logo/remove", async (c) => {
    await removeLogo(ctx);
    return c.redirect("/settings/branding?msg=nologo");
  });
  app.post("/settings/branding/message", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setDefaultMessage(ctx, str(b, "message"));
      return c.redirect("/settings/branding?msg=saved");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`<div class="notice bad">${e.message}</div><a class="btn" href="/settings/branding">Back</a>`);
    }
  });

  app.get("/outbox/:id/html", async (c) => {
    const m = await ctx.mailer.outboxEntry(c.req.param("id"));
    if (!m) return c.notFound();
    return emailPage(c, m.html, avatarOrigin(ctx.config));
  });

  // ---- Outbox ----

  app.get("/outbox", async (c) => {
    const account = await getAccount(ctx);
    const smtp = ctx.mailer.effectiveSmtp(account.config.smtp);
    const mails = await ctx.mailer.outbox(50);
    return page(c, "Outbox", "outbox", html`<div class="page-head"><h1>Outbox</h1></div>
      <div class="notice ${smtp ? "info" : "warn"}">${smtp ? `SMTP is configured (${smtp.host}). New emails are sent there. This list shows emails written before SMTP was set.` : "No SMTP server is set. Emails are kept here instead of being sent, so you can test the full flow. Configure SMTP in Settings."}</div>
      ${mails.length === 0 ? html`<div class="card empty">No emails yet.</div>` : mails.map((m, i) => html`<details class="card" ${i === 0 ? "open" : ""}><summary><strong>${m.subject}</strong> <span class="muted">→ ${m.to} · ${when(m.created_at)}</span></summary>
        ${m.html ? html`<iframe class="email-frame" src="/outbox/${m.id}/html" title="${m.subject}" loading="lazy"></iframe>` : ""}
        ${m.attachments.length ? html`<p class="small muted">Attachments: ${m.attachments.map((a) => `${a.filename} (${Math.round(a.size / 1024)} KB)`).join(", ")}</p>` : ""}
        <details class="small"><summary>Plain text version</summary><pre>${m.text}</pre></details></details>`)}`);
  });

  return app;
}

// ---------------------------------------------------------------------------

/** Avatar with initials underneath; app.js removes the image if it fails to load. */
function avatar(ctx: Ctx, enabled: boolean, name: string, email: string, size: "sm" | "md" = "md"): H {
  const url = avatarUrl(ctx.config, enabled, email);
  return html`<span class="avatar avatar-${size}" title="${name} <${email}>"><span>${initialsOf(name)}</span>${url ? html`<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}

function variablesHint(): H {
  return html`<p class="small muted" style="margin:6px 0 0">Placeholders, filled in for each signer: ${MESSAGE_VARIABLES.map((v, i) => html`${i ? ", " : ""}<code>{{${v}}}</code>`)}.</p>`;
}

function settingsTabs(active: "general" | "branding"): H {
  return html`<nav class="tabs-nav"><a href="/settings" class="${active === "general" ? "active" : ""}">General</a><a href="/settings/branding" class="${active === "branding" ? "active" : ""}">Branding</a></nav>`;
}

/** Serve email HTML for same-origin preview frames. Scripts stay blocked; only framing by this app is allowed. */
function emailPage(c: Context, body: string, imgOrigin = "") {
  c.header("content-security-policy", `default-src 'none'; img-src data: 'self' ${imgOrigin}; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`);
  c.header("x-frame-options", "SAMEORIGIN");
  return c.html(body);
}

/** Turn actor references ("user:usr_x", "apikey:key_x") into readable names. */
async function actorNames(ctx: Ctx, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (kind: string) => refs.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
  const users = ids("user");
  const keys = ids("apikey");
  if (users.length) for (const u of await ctx.db.selectFrom("users").select(["id", "email"]).where("id", "in", users).execute()) out.set(`user:${u.id}`, u.email);
  if (keys.length) for (const k of await ctx.db.selectFrom("api_keys").select(["id", "label"]).where("id", "in", keys).execute()) out.set(`apikey:${k.id}`, `API key “${k.label}”`);
  return out;
}

function signerKeys(fields: FieldDef[]): string[] {
  return [...new Set(fields.filter((f) => f.kind === "signer").map((f) => f.signer!))];
}

async function completedHtml(ctx: Ctx, id: string): Promise<string> {
  const { renderCompletedValue } = await import("../services/signing.ts");
  const row = await docs.loadDocument(ctx.db, id);
  const fieldRows = await ctx.db.selectFrom("fields").selectAll().where("document_id", "=", id).execute();
  const defs = fieldRows.map((f) => JSON.parse(f.definition) as FieldDef);
  const values = new Map(fieldRows.filter((f) => f.value !== null && f.kind === "signer").map((f) => [f.key, JSON.parse(f.value!)]));
  return renderHtml(row.content, { fields: defs, renderField: (def) => (values.has(def.key) ? renderCompletedValue(def, values.get(def.key)) : null) });
}

function setupPage(error?: string, b?: FormBody): H {
  return shell({ title: "Set up" }, html`<div class="narrow" style="margin:40px auto">
    <h1>Set up Signed.md</h1><p class="muted">Create the administrator account. You can change everything later.</p>
    ${error ? html`<div class="notice bad">${error}</div>` : ""}
    <form method="post" class="card">
      <div class="field"><label>Company name</label><input type="text" name="account" value="${b ? str(b, "account") : ""}" required></div>
      <div class="field"><label>Your email</label><input type="email" name="email" value="${b ? str(b, "email") : ""}" required autocomplete="username"></div>
      <div class="field"><label>Password <span class="muted">· at least 10 characters</span></label><input type="password" name="password" required minlength="10" autocomplete="new-password"></div>
      <button class="btn primary block">Create account</button>
    </form></div>`);
}

function loginPage(error?: string, email = ""): H {
  return shell({ title: "Log in" }, html`<div class="narrow" style="margin:60px auto">
    <h1>Signed.md</h1>
    ${error ? html`<div class="notice bad">${error}</div>` : ""}
    <form method="post" class="card">
      <div class="field"><label>Email</label><input type="email" name="email" value="${email}" required autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
      <button class="btn primary block">Log in</button>
    </form></div>`);
}

function inlineStart(csrf: string, content = "# Agreement\n\nThis agreement is between {{$party_a:text}} and {{$party_b:text}}.\n\nSigned: {{client.signature:signature}}\n"): H {
  return html`<div class="page-head"><h1>New inline document</h1></div>
    <form method="post" action="/documents/new/inline" class="card">${csrfInput(csrf)}
      <div class="field"><label>Markdown</label><textarea class="code" name="content">${content}</textarea></div>
      <p class="small muted">Use <code>{{$name:type}}</code> for values you fill in now and <code>{{signer.field:type}}</code> for what signers fill in.</p>
      <button class="btn primary">Continue</button></form>`;
}

interface DocFormState {
  mode: "template" | "inline";
  templateId?: string;
  templateName?: string;
  version?: number;
  content?: string;
  editId?: string;
  fields: FieldDef[];
  values: Record<string, unknown>;
  signers: { key: string; name: string; email: string; order: number }[];
  title?: string;
  expires?: number;
}

function documentForm(csrf: string, s: DocFormState): H {
  const valueFields = s.fields.filter((f) => f.kind === "value");
  return html`<div class="page-head"><h1>${s.editId ? "Edit draft" : "New document"}</h1>${s.templateName ? html`<span class="muted">From ${s.templateName} v${s.version}</span>` : ""}</div>
    <form method="post" action="${s.editId ? `/documents/${s.editId}/edit` : "/documents"}">${csrfInput(csrf)}
      ${s.templateId ? html`<input type="hidden" name="template_id" value="${s.templateId}">` : ""}
      ${s.mode === "inline" ? (s.editId ? html`<div class="card"><h2>Markdown</h2><textarea class="code" name="content">${s.content ?? ""}</textarea></div>` : html`<input type="hidden" name="content" value="${s.content ?? ""}">`) : ""}
      <div class="card"><h2>Details</h2>
        <div class="inline-fields" style="grid-template-columns:2fr 1fr"><div class="field"><label>Title <span class="muted">· optional</span></label><input type="text" name="title" value="${s.title ?? ""}"></div>
        <div class="field"><label>Expires after (days)</label><input type="number" min="1" max="365" name="expires_in_days" value="${s.expires ?? ""}" placeholder="default"></div></div>
      </div>
      ${valueFields.length ? html`<div class="card"><h2>Values</h2>${valueFields.map((f) => valueInput(f, s.values[f.name!]))}</div>` : ""}
      <div class="card"><h2>Signers</h2>${signerRows(s.signers, s.mode === "template")}${s.mode === "inline" ? html`<button class="btn small" id="add-signer" style="margin-top:8px">Add signer</button>` : ""}</div>
      <button class="btn primary">${s.editId ? "Save draft" : "Create draft"}</button> <span class="small muted">You'll preview it before sending.</span>
    </form>`;
}

function templateForm(csrf: string, s: { id?: string; name: string; description: string; source: string }): H {
  return html`<div class="page-head"><h1>${s.id ? "New template version" : "New template"}</h1></div>
    <form method="post" action="${s.id ? `/templates/${s.id}/edit` : "/templates"}">${csrfInput(csrf)}
      <div class="card">
        <div class="field"><label>Name</label><input type="text" name="name" value="${s.name}" required></div>
        <div class="field"><label>Description <span class="muted">· optional</span></label><input type="text" name="description" value="${s.description}"></div>
        <div class="field"><label>Markdown</label><textarea class="code" name="source">${s.source}</textarea></div>
        <details><summary>Placeholder reference</summary><div class="small" style="margin-top:8px">
          <p><code>{{$name:type}}</code> – a value filled in when the document is created (by you or an agent).<br>
          <code>{{signer.field:type}}</code> – filled in by that signer while signing, e.g. <code>{{client.signature:signature}}</code>.</p>
          <p>Types: <code>text</code>, <code>longtext</code>, <code>number</code>, <code>currency(USD)</code>, <code>date</code>, <code>signature</code>, <code>initials</code>, <code>checkbox</code>, <code>choice(a|b)</code>.</p>
          <p>Optional front matter adds rules: <code>label</code>, <code>required</code>, <code>default</code>, <code>minimum</code>, <code>maximum</code>, <code>max_length</code>, <code>allowed_values</code>, <code>options</code>. Write <code>\\{{</code> for literal braces.</p></div></details>
      </div>
      <div class="row"><button class="btn primary" name="approve" value="1">Save and approve</button><button class="btn" name="approve" value="0">Save as pending</button></div>
    </form>`;
}
