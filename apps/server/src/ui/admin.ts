import { type FieldDef, parseTemplate, renderHtml, SignedError } from "@signed-md/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { Actor, Ctx } from "../context.ts";
import { safeEqual } from "../crypto.ts";
import { WEBHOOK_EVENTS } from "../http/api.ts";
import { clientIp, rateLimit } from "../http/ratelimit.ts";
import { getAccount, isSetUp, newWebhookSecret, setup, updateAccount, type InlineDocumentsSetting } from "../services/accounts.ts";
import { type LimitHit, limitReached, remaining } from "../services/usage.ts";
import { IMPORT_ACCEPT, importDocument } from "../services/imports.ts";
import { changePassword, createApiKey, csrfToken, listApiKeys, login, revokeApiKey, SESSION_SECONDS, sessionActor, sessionCookie } from "../services/auth.ts";
import * as docs from "../services/documents.ts";
import { listEvents } from "../services/events.ts";
import { downloadLink, listArtifacts } from "../services/finalize.ts";
import * as tpl from "../services/templates.ts";
import * as folders from "../services/folders.ts";
import { listDeliveries } from "../services/webhooks.ts";
import { listActivity } from "../services/audit.ts";
import { can, canManageDocument, requirePermission, ROLE_LABELS, ROLES } from "../services/permissions.ts";
import * as team from "../services/team.ts";
import { readLogo, removeLogo, setBannerAndAvatars, setContractFont, setDefaultMessage, setLogo } from "../services/branding.ts";
import { CONTRACT_FONTS, CONTRACT_FONT_NAMES, type ContractFont } from "../services/fonts.ts";
import { avatarOrigin, avatarUrl, emailAvatar, initialsOf } from "../services/avatars.ts";
import { renderEmail } from "../services/emailtemplate.ts";
import { HOSTED_APP_URL } from "../hosted.ts";
import { brandAttachment } from "../services/emails.ts";
import { MESSAGE_VARIABLES, personalizeMessage } from "../services/messagevars.ts";
import { type FormBody, parseSigners, parseValues, signerRows, str, valueInput } from "./forms.ts";
import { alert, asset, avatarFigure, badge, csrfInput, empty, eventIcon, field, type H, icon, issuesList, shell, when } from "./layout.ts";
import { canEmailResets, findPasswordReset, RESET_MINUTES, requestPasswordReset, resetPassword } from "../services/passwordreset.ts";

type Env = { Variables: { user: Actor & { kind: "user" }; csrf: string } };

const COOKIE = "smd_session";

const MESSAGES: Record<string, ["ok" | "bad" | "warn" | "info", string]> = {
  sent: ["ok", "Sent. Signers in the first group have their links."],
  revoked: ["ok", "Revoked. Signing links no longer work."],
  archived: ["ok", "Archived."],
  unarchived: ["ok", "Restored from the archive."],
  folder_deleted: ["ok", "Folder deleted. What was in it is now at the top level."],
  resent: ["ok", "A new link was sent."],
  approved: ["ok", "Approved."],
  saved: ["ok", "Saved."],
  created: ["ok", "Created."],
  password: ["ok", "Password changed."],
  invited: ["ok", "Invitation sent."],
  team: ["ok", "Team updated."],
  profile: ["ok", "Profile saved."],
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

  // Permission and not-found errors become pages, not JSON.
  app.onError((e, c) => {
    if (e instanceof SignedError && ["PERMISSION_DENIED", "NOT_FOUND", "DOCUMENT_NOT_FOUND", "TEMPLATE_NOT_FOUND"].includes(e.code)) {
      const user = c.get("user");
      const body = html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/documents">Back to documents</a>`;
      return c.html(shell({ title: "Not allowed", ...(user ? { user: { email: user.label, name: user.name, role: user.role } } : {}), csrf: c.get("csrf") ?? "" }, body), e.code === "PERMISSION_DENIED" ? 403 : 404);
    }
    throw e;
  });

  const flash = (c: Context) => {
    const m = MESSAGES[c.req.query("msg") ?? ""];
    return m ? { kind: m[0], text: m[1] } : null;
  };
  const accountFont = async (): Promise<ContractFont> => (await getAccount(ctx)).config.branding.contract_font;
  /** Editors and document pages use the whole width of the window. */
  const FULL = { full: true };
  const page = async (c: Context<Env>, title: string, active: string, body: H, extra?: { kind: "ok" | "bad" | "warn" | "info"; text: string } | null, opts: { full?: boolean } = {}) =>
    c.html(shell({ title, usage: can(c.get("user"), "documents.create") ? await remaining(ctx) : null, user: { email: c.get("user").label, name: c.get("user").name, role: c.get("user").role, theme: c.get("user").theme ?? "system", avatar: ctx.config.hosted ? avatarUrl(ctx.config, true, c.get("user").label, c.get("user").name) : null }, csrf: c.get("csrf"), active, flash: extra ?? flash(c), full: opts.full, collapsed: getCookie(c, "smd_sidebar") === "collapsed" }, body));

  // Login cookie: renewed for another hour on every page visit. COOKIE_DOMAIN shares it with
  // subdomains (the hosted service uses .signed.md, so app.signed.md can log people in).
  const cookieOpts = { httpOnly: true, sameSite: "Lax" as const, secure, path: "/", ...(ctx.config.cookieDomain ? { domain: ctx.config.cookieDomain } : {}) };
  const setSession = (c: Context<Env>, value: string) => setCookie(c, COOKIE, value, { ...cookieOpts, maxAge: SESSION_SECONDS });

  // ---- Public: setup and login ----

  const loginLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (c) => `login:${clientIp(c)}` });

  app.get("/setup", async (c) => {
    // Without email login, the first owner is created with the CLI (the hosted service does this).
    if (!ctx.config.allowEmailLogin || (await isSetUp(ctx))) return c.redirect("/login");
    return c.html(setupPage());
  });
  app.post("/setup", loginLimit, async (c) => {
    if (!ctx.config.allowEmailLogin || (await isSetUp(ctx))) return c.redirect("/login");
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setup(ctx, { accountName: str(b, "account"), name: str(b, "name"), email: str(b, "email"), password: str(b, "password") });
      const s = await login(ctx, str(b, "email"), str(b, "password"));
      setSession(c, s!.token);
      return c.redirect("/documents?welcome=1");
    } catch (e) {
      return c.html(setupPage((e as Error).message, b), 400);
    }
  });

  // Email login unless ALLOW_EMAIL_LOGIN=false, plus optional Google and Microsoft buttons
  // (OAUTH_*_URL). Hosted: app.signed.md signs people in and writes the cookie for .signed.md.
  const next = `${ctx.config.publicUrl}/documents`;
  const withNext = (url: string | null) => (url ? `${url}${url.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : null);
  const buttons = { google: withNext(ctx.config.oauth.google), microsoft: withNext(ctx.config.oauth.microsoft) };
  const loginView = (error?: string, email?: string) => loginPage(error, email, buttons, ctx.config.allowEmailLogin);
  app.get("/login", async (c) => {
    if (ctx.config.allowEmailLogin && !(await isSetUp(ctx))) return c.redirect("/setup");
    return c.html(loginView());
  });
  app.post("/login", loginLimit, async (c) => {
    if (!ctx.config.allowEmailLogin) return c.redirect("/login");
    const b = (await c.req.parseBody()) as FormBody;
    const s = await login(ctx, str(b, "email"), str(b, "password"));
    if (!s) return c.html(loginView("Email or password is not correct.", str(b, "email")), 401);
    setSession(c, s.token);
    return c.redirect("/documents");
  });

  // ---- Public: forgot password (email login only) ----
  // The answer never says whether an account exists. Reset pages are never cached.

  app.get("/forgot", (c) => {
    if (!ctx.config.allowEmailLogin) return c.redirect("/login");
    return c.html(forgotPage("", false, canEmailResets(ctx)));
  });
  app.post("/forgot", loginLimit, async (c) => {
    if (!ctx.config.allowEmailLogin) return c.redirect("/login");
    const email = str((await c.req.parseBody()) as FormBody, "email").trim();
    await requestPasswordReset(ctx, email);
    return c.html(forgotPage(email, true));
  });
  app.get("/reset/:token", async (c) => {
    c.header("cache-control", "no-store");
    const reset = await findPasswordReset(ctx, c.req.param("token"));
    return reset ? c.html(resetPage(reset.email)) : c.html(resetInvalidPage(), 404);
  });
  app.post("/reset/:token", loginLimit, async (c) => {
    c.header("cache-control", "no-store");
    const token = c.req.param("token");
    const reset = await findPasswordReset(ctx, token);
    if (!reset) return c.html(resetInvalidPage(), 404);
    try {
      setSession(c, await resetPassword(ctx, token, str((await c.req.parseBody()) as FormBody, "password")));
      return c.redirect("/documents?msg=password");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return c.html(resetPage(reset.email, e.message), 422);
    }
  });

  // ---- Public: accept an invitation ----

  app.get("/invite/:token", async (c) => {
    const inv = await team.findInvitation(ctx, c.req.param("token"));
    if (!inv) return c.html(authPage("Invitation", html`<div class="card"><h1>Invitation not valid</h1><p class="muted">This invitation has expired, was revoked, or was already used. Ask for a new one.</p><a class="button outline" href="/login">Log in</a></div>`), 404);
    return c.html(invitePage(inv, null, "", !ctx.config.allowEmailLogin));
  });
  app.post("/invite/:token", loginLimit, async (c) => {
    const token = c.req.param("token");
    const b = (await c.req.parseBody()) as FormBody;
    const inv = await team.findInvitation(ctx, token);
    if (!inv) return c.redirect(`/invite/${token}`);
    try {
      const session = await team.acceptInvitation(ctx, token, { name: str(b, "name"), ...(ctx.config.allowEmailLogin ? { password: str(b, "password") } : {}) });
      setSession(c, session);
      return c.redirect("/documents?welcome=1");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return c.html(invitePage(inv, e.message, str(b, "name"), !ctx.config.allowEmailLogin), 422);
    }
  });

  // ---- Session + CSRF for everything else ----

  const PUBLIC = ["/setup", "/login", "/forgot"];
  app.use("*", async (c, next) => {
    if (PUBLIC.includes(c.req.path) || c.req.path.startsWith("/invite/") || c.req.path.startsWith("/reset/")) return next();
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
    setSession(c, sessionCookie(ctx, user.label));
    await next();
  });

  app.post("/logout", async (c) => {
    deleteCookie(c, COOKIE, cookieOpts);
    return c.redirect("/login");
  });

  app.get("/", (c) => c.redirect("/documents"));

  // Live preview for the Markdown editors. Pure rendering: reads no stored data.
  app.post("/preview", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const source = str(b, "source").replace(/\r\n?/g, "\n");
    if (source.length > 500_000) return c.html(html`${alert("bad", html`Too large to preview (max 500 KB).`)}`);
    const font = str(b, "font");
    return c.html(markdownPreview(source, isContractFont(font) ? font : (await getAccount(ctx)).config.branding.contract_font));
  });

  // ---- Documents ----

  app.get("/documents", async (c) => {
    const archived = c.req.query("archived") === "1";
    const status = c.req.query("status") || undefined;
    const q = c.req.query("q") || undefined;
    const user = c.get("user");
    const seesAll = can(user, "documents.read_all");
    const mine = !seesAll || c.req.query("mine") === "1";
    const docFolders = await folders.listFolders(ctx, "document");
    const current = docFolders.find((f) => f.id === c.req.query("folder"));
    if (c.req.query("folder") && !current) return c.redirect("/documents");
    // The top level lists everything, with each row showing its folder. A folder narrows the list.
    const filtering = !!(q || status || archived);
    const folder = current ? current.id : undefined;
    const listUrl = hereWithout(c.req.url, "msg");
    const before = c.req.query("before") || undefined;
    const after = c.req.query("after") || undefined;
    const list = await docs.listDocuments(ctx, user, { archived, mine, ...(status ? { status } : {}), ...(q ? { q } : {}), ...(folder ? { folder } : {}), ...(before ? { before } : after ? { after } : {}), limit: 25 });
    const paged = !!(before || after) && !!list.newer_after;
    // Signed PDFs of finished documents on this page, for the download button in each row (links last an hour).
    const pdfIds = list.data.length
      ? await ctx.db.selectFrom("artifacts").select(["id", "document_id"]).where("type", "=", "pdf").where("document_id", "in", list.data.map((d) => d.id)).execute()
      : [];
    const pdfOf = new Map(pdfIds.map((a) => [a.document_id, downloadLink(ctx, a.id, 3600).url]));
    const manageFolders = can(user, "documents.create");
    const avatarsOn = (await getAccount(ctx)).config.branding.avatars;
    const welcome = c.req.query("welcome") === "1";
    const hit = can(user, "documents.create") ? await limitReached(ctx) : null;
    return page(
      c,
      "Documents",
      "documents",
      html`
      ${hit ? limitAlert(hit) : ""}
      ${welcome ? html`${alert("info", html`<strong>Welcome to Signed.md.</strong> ${user.role === "owner" ? "Next steps: create a template, invite your team, and create an API key in Settings so your agent can send agreements." : user.role === "viewer" ? "You can read every document and template." : "Create an API key in Settings to connect your agent, or start a document from an approved template."}`)}` : ""}
      ${folderHead("Documents", "/documents", current, can(user, "documents.create") ? newMenu("document", withQuery("/documents/new", { folder: current?.id }), manageFolders && !current, c.get("csrf")) : "")}
      ${!current && !filtering && !paged ? folderGrid("document", docFolders, await folders.folderCounts(ctx, "document", mine ? user.id : undefined), (id) => withQuery("/documents", { folder: id, mine: mine && seesAll ? "1" : undefined }), manageFolders, c.get("csrf")) : ""}
      ${seesAll ? tabs("Which documents", [["All documents", withQuery("/documents", { folder: current?.id, archived: archived ? "1" : undefined }), !mine], ["Mine", withQuery("/documents", { folder: current?.id, mine: "1", archived: archived ? "1" : undefined }), mine]]) : ""}
      <search><form class="row filter-form" method="get" aria-label="Filter documents">
        <input type="search" name="q" value="${q ?? ""}" placeholder="Search title, signer name or email" aria-label="Search title, signer name or email" autocapitalize="none" spellcheck="false">
        <select name="status" aria-label="Status"><option value="">Any status</option>
          ${["draft", "sent", "partially_signed", "signed", "finalized", "declined", "expired", "revoked"].map((s) => html`<option value="${s}" ${s === status ? "selected" : ""}>${s.replace("_", " ")}</option>`)}
        </select>
        ${archived ? html`<input type="hidden" name="archived" value="1">` : ""}
        ${mine && seesAll ? html`<input type="hidden" name="mine" value="1">` : ""}
        ${current ? html`<input type="hidden" name="folder" value="${current.id}">` : ""}
        <button type="submit" class="outline">Filter</button>
      </form></search>
      <div class="card table">
      ${list.data.length === 0
        ? current ? empty("Nothing in this folder") : archived ? empty("Nothing archived") : filtering ? empty("No matches") : empty("No documents yet", html`<a href="/documents/new">Create one</a> or connect an agent.`)
        : html`<table class="stack"><thead><tr><th>Title</th><th>Folder</th><th>Status</th><th>Signers</th>${seesAll && !mine ? html`<th>Owner</th>` : ""}<th>Created</th><th><span class="sr-only">Download</span></th></tr></thead><tbody>
          ${list.data.map((d) => {
            const signed = d.signers.filter((s) => s.status === "signed").length;
            return html`<tr>
              <td class="cell-main"><a class="item-cell" href="/documents/${d.id}">${icon("file")}<div><strong>${d.title}</strong><div class="small muted mono">${d.id}</div></div></a></td>
              <td class="cell-meta lead">${folderCell("document", d, docFolders, canManageDocument(user, { owner_user_id: d.owner?.id ?? null }), c.get("csrf"), listUrl)}</td>
              <td class="cell-status">${badge(d.status, d.status === "partially_signed" ? `${signed} of ${d.signers.length} signed` : undefined)}</td>
              <td class="cell-wide"><figure data-variant="avatar" role="group" class="small signers" aria-label="Signers">${d.signers.map((s) => avatar(ctx, avatarsOn, s.name, s.email, "small", signerLabel(s)))}</figure></td>
              ${seesAll && !mine ? html`<td class="cell-meta">${d.owner ? html`<div class="row" style="gap:8px;flex-wrap:nowrap">${avatar(ctx, avatarsOn, d.owner.name, d.owner.email, "small")}<span class="small">${d.owner.name}</span></div>` : html`<span class="muted">–</span>`}</td>` : ""}
              <td class="nowrap cell-meta">${when(d.created_at)}</td>
              <td class="cell-meta row-action${pdfOf.has(d.id) ? "" : " hide-sm"}">${pdfOf.has(d.id) ? html`<a class="button ghost icon small" href="${pdfOf.get(d.id)}" aria-label="Download the signed PDF of ${d.title}" title="Download signed PDF">${icon("download")}</a>` : ""}</td></tr>`;
          })}
        </tbody></table>`}
      </div>
      ${pager(c.req.url, "documents", list.newer_after, list.next_before)}
      <p><a class="small" href="${withQuery("/documents", { folder: current?.id, mine: mine && seesAll ? "1" : undefined, archived: archived ? undefined : "1" })}">${archived ? "Back to active documents" : "View archive"}</a></p>`,
    );
  });

  app.get("/documents/new", async (c) => {
    requirePermission(c.get("user"), "documents.create");
    const hit = await limitReached(ctx);
    if (hit) return page(c, "New document", "documents", html`<div class="page-head"><h1>New document</h1></div>${limitAlert(hit)}`);
    const templateId = c.req.query("template");
    if (templateId) {
      const v = await tpl.resolveVersionForDocument(ctx, templateId).catch((e: Error) => e);
      if (v instanceof Error) return page(c, "New document", "documents", html`${alert("bad", html`${v.message}`)}<a href="/documents/new">Back</a>`);
      const parsed = parseTemplate(v.source);
      return page(c, "New document", "documents", documentForm(c.get("csrf"), { folders: await folders.listFolders(ctx, "document"), folderId: c.req.query("folder") ?? null, mode: "template", templateId, templateName: v.template.name, version: v.version, fields: parsed.fields, signers: signerKeys(parsed.fields).map((key, i) => ({ key, name: "", email: "", order: i + 1 })), values: {}, preview: v.source, previewFont: await accountFont() }));
    }
    const inFolder = c.req.query("folder") || undefined;
    if (c.req.query("inline") === "1") return page(c, "New document", "documents", inlineStart(c.get("csrf"), await accountFont(), undefined, inFolder), undefined, FULL);
    const templates = (await tpl.listTemplates(ctx)).filter((t) => t.approved_version !== null);
    const account = await getAccount(ctx);
    return page(
      c,
      "New document",
      "documents",
      html`<div class="page-head"><h1>New document</h1></div>
      <section class="card" aria-labelledby="start-from-an-approved-template"><header><h2 id="start-from-an-approved-template">Start from an approved template</h2></header>
        ${templates.length === 0
          ? html`<p class="muted">No approved templates yet. <a href="/templates/new">Create a template</a>.</p>`
          : html`<table><tbody>${templates.map((t) => html`<tr><td><strong>${t.name}</strong><div class="small muted">${t.description}</div></td><td class="nowrap">v${t.approved_version}</td><td style="text-align:right"><a class="button outline small" href="${withQuery("/documents/new", { template: t.id, folder: inFolder })}">Use</a></td></tr>`)}</tbody></table>`}
      </section>
      ${account.config.inline_documents !== "disabled"
        ? html`<section class="card" aria-labelledby="or-write-it-now"><header><h2 id="or-write-it-now">Or write it now</h2></header><p class="muted small">Paste Markdown with placeholders. No approved template protects inline legal language.</p><p><a class="button outline" href="${withQuery("/documents/new", { inline: "1", folder: inFolder })}">Write inline Markdown</a></p>${importForm(c.get("csrf"), withQuery("/documents/new/import", { folder: inFolder }), "Or import a Word or PDF file")}</section>`
        : ""}`,
    );
  });

  app.post("/documents/new/import", async (c) => {
    requirePermission(c.get("user"), "documents.create");
    const b = (await c.req.parseBody()) as FormBody;
    try {
      const file = b.file;
      if (!(file instanceof File)) throw new SignedError("INVALID_REQUEST", "Choose a file to import");
      const doc = await importDocument(file.name, new Uint8Array(await file.arrayBuffer()));
      return page(c, "New document", "documents", html`${alert("info", html`<strong>Converted from ${file.name}.</strong> Read it carefully: conversion can change layout. Add signer fields such as <code>{{client.signature:signature}}</code> where people sign.`)}
        ${inlineStart(c.get("csrf"), await accountFont(), doc.markdown, c.req.query("folder"))}`, undefined, FULL);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "New document", "documents", html`${alert("bad", e.message)}<a class="button outline" href="/documents/new">Back</a>`);
    }
  });

  // Inline step 1 → step 2: parse the content to find values and signers.
  app.post("/documents/new/inline", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const content = str(b, "content");
    const parsed = parseTemplate(content);
    if (parsed.issues.length) return page(c, "New document", "documents", html`${alert("bad", html`The Markdown has problems:${issuesList(parsed.issues)}`)}${inlineStart(c.get("csrf"), await accountFont(), content, c.req.query("folder"))}`, undefined, FULL);
    return page(c, "New document", "documents", documentForm(c.get("csrf"), { folders: await folders.listFolders(ctx, "document"), folderId: c.req.query("folder") ?? null, mode: "inline", content, fields: parsed.fields, signers: signerKeys(parsed.fields).map((key, i) => ({ key, name: "", email: "", order: i + 1 })), values: {}, preview: content, previewFont: await accountFont() }));
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
        ...(str(b, "font") ? { font: str(b, "font") } : {}),
        ...(str(b, "folder_id") ? { folder_id: str(b, "folder_id") } : {}),
      });
      return c.redirect(`/documents/${d.id}?msg=created`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      const hit = e.code === "LIMIT_REACHED" ? await limitReached(ctx) : null;
      if (hit) return page(c, "New document", "documents", limitAlert(hit));
      return page(c, "New document", "documents", html`${alert("bad", html`${e.message}${e.issues.length ? issuesList(e.issues) : ""}`)}
        ${documentForm(c.get("csrf"), { folders: await folders.listFolders(ctx, "document"), folderId: str(b, "folder_id") || null, mode: templateId ? "template" : "inline", ...(templateId ? { templateId } : { content: content! }), fields, signers, values, title: str(b, "title"), preview: templateId ? (await tpl.resolveVersionForDocument(ctx, templateId).catch(() => null))?.source : content!, previewFont: await accountFont() })}`);
    }
  });

  /**
   * A document: its pages on a canvas on the left, and a side panel on the right. For a draft the
   * panel sends it and edits its details, values and signers; ?edit=text swaps the pages for the
   * Markdown editor (inline drafts). After sending, the panel shows progress and the evidence.
   */
  const documentPage = async (c: Context<Env>, id: string, opts: { error?: H } = {}) => {
    const user = c.get("user");
    const d = await docs.getDocument(ctx, user, id);
    const manage = canManageDocument(user, { owner_user_id: d.owner?.id ?? null });
    const account = await getAccount(ctx);
    const events = await listEvents(ctx.db, id);
    const draft = d.status === "draft";
    const editable = draft && manage;
    const preview = draft ? await docs.previewDocument(ctx, user, id) : null;
    const artifacts = d.status === "finalized" ? await listArtifacts(ctx, user, id, 300) : [];
    const docHtml = preview ? preview.html : await completedHtml(ctx, id);
    const csrf = c.get("csrf");
    const active = d.status === "sent" || d.status === "partially_signed";
    const inlineNeedsApproval = d.inline_approval?.required && !d.inline_approval.approved;
    const row = editable ? await docs.loadDocument(ctx.db, id) : null;
    const fields = row ? parseTemplate(row.source).fields : [];
    const valueFields = fields.filter((f) => f.kind === "value");
    const editingText = editable && d.source === "inline" && c.req.query("edit") === "text";
    const canInline = account.config.inline_documents !== "disabled" && can(user, "documents.create");
    const docFolders = await folders.listFolders(ctx, "document");
    const signedCount = d.signers.filter((s) => s.status === "signed").length;

    const head = html`<header class="doc-head">
      <div><h1>${d.title}</h1><div class="row small muted">${copyValue(d.id)} ${badge(d.status, d.status === "partially_signed" ? `${signedCount} of ${d.signers.length} signed` : undefined)} ${d.archived ? badge("archived") : ""} ${d.source === "inline" ? html`<span class="badge" data-variant="warning">inline</span>` : ""}</div></div>
      <div class="row">
        ${editable && !editingText
          ? d.source === "inline"
            ? html`<a class="button outline small" href="/documents/${d.id}?edit=text">${icon("pencil")} Edit text</a>`
            : canInline ? html`<button type="button" class="outline small" commandfor="detach-dialog" command="show-modal">${icon("pencil")} Edit text</button>` : ""
          : ""}
        ${manage ? html`<form method="post" action="/documents/${d.id}/${d.archived ? "unarchive" : "archive"}" class="inline">${csrfInput(csrf)}<button type="submit" class="outline small">${d.archived ? "Unarchive" : "Archive"}</button></form>` : ""}
      </div>
    </header>
    ${editable && d.source === "template" && canInline
      ? html`<dialog id="detach-dialog" closedby="any" aria-labelledby="detach-title" aria-describedby="detach-text">
          <form method="post" action="/documents/${d.id}/to-inline">${csrfInput(csrf)}
            <header><h2 id="detach-title">Edit the text of this document?</h2></header>
            <p id="detach-text" class="small">It becomes an <strong>inline document</strong>: the approved template${d.template ? html` (v${d.template.version})` : ""} no longer protects its legal language.${account.config.inline_documents === "needs_approval" ? " An owner must approve it before it's sent." : ""} The change is recorded in the evidence log and can't be undone.</p>
            <footer><button type="button" class="outline" commandfor="detach-dialog" command="close">Cancel</button><button type="submit">Edit as inline</button></footer>
          </form>
        </dialog>`
      : ""}`;

    const canvas = html`${preview && preview.errors.length ? html`${alert("bad", html`<strong>Not ready to send.</strong>${issuesList(preview.errors)}`)}` : ""}
        <div class="pages" data-paginate role="group" aria-label="Document"><article class="doc page ${CONTRACT_FONTS[d.font].css}"><div class="page-body">${raw(docHtml)}</div></article></div>`;

    const sendBlock = editable
      ? html`<section class="panel-block" aria-labelledby="send"><h2 id="send">Send</h2>
          ${preview!.valid
            ? inlineNeedsApproval
              ? can(user, "inline.approve")
                ? html`<p class="small">This account requires an owner to approve inline documents.</p>
                  <form method="post" action="/documents/${d.id}/approve-inline">${csrfInput(csrf)}<input type="hidden" name="revision" value="${preview!.revision}"><button type="submit" class="outline w-full">Approve this revision</button></form>`
                : html`<p class="small muted">This account requires an owner to approve inline documents before they're sent. Ask an owner to open this document.</p>`
              : html`<form method="post" action="/documents/${d.id}/send" data-confirm="Send this document for signature now?">${csrfInput(csrf)}
                  <input type="hidden" name="approved_revision" value="${preview!.revision}">
                  <details class="link-details tiny"><summary>Message to signers</summary>
                    <div data-field><label for="f-message" class="sr-only">Message to signers</label><textarea id="f-message" name="message" style="min-height:90px" maxlength="2000" placeholder="Shown in the signing email">${account.config.branding.email_message}</textarea>${variablesHint()}</div>
                    <div data-field><label for="f-approved_by">Approved by</label><input id="f-approved_by" type="text" name="approved_by" value="${user.label}"></div>
                  </details>
                  <button type="submit" class="w-full main-action">Send for signature</button>
                  <p class="tiny muted" style="margin:6px 0 0">You're approving revision <code>${preview!.revision.slice(0, 16)}…</code>, the pages you see. Any edit needs a new look.</p></form>`
            : html`<p class="small muted">Fix the problems shown on the document, then send.</p>`}
        </section>`
      : html`<section class="panel-block row-stretch" aria-labelledby="status"><h2 id="status">${d.status === "finalized" ? "Signed" : active ? `${signedCount} of ${d.signers.length} signed` : badge(d.status)}</h2>
          ${artifacts.length ? html`<div class="stack">${artifacts.map((a) => html`<a class="button w-full${a.type === "zip" ? " main-action" : ""}" href="${a.download.url}">${a.type === "zip" ? "Download package (.zip)" : "Download signed PDF"}</a>`)}
            <p class="tiny muted">Verify the package offline with <code>npx signed-md verify file.zip</code>.</p></div>` : ""}
          ${active && manage ? html`<button type="button" data-variant="danger" class="outline small" commandfor="revoke-dialog" command="show-modal">Revoke</button>
            <dialog id="revoke-dialog" closedby="any" aria-labelledby="revoke-title"><form method="post" action="/documents/${d.id}/revoke">${csrfInput(csrf)}
              <header><h2 id="revoke-title">Revoke this document?</h2></header>
              <div><p class="small">Signing links stop working at once. This can't be undone. To fix a mistake, revoke and create a new document.</p>
              <div data-field><label for="f-revoke-reason">Reason <span class="muted">· optional</span></label><input id="f-revoke-reason" type="text" name="reason"></div></div>
              <footer><button type="button" class="outline" commandfor="revoke-dialog" command="close">Cancel</button><button data-variant="danger" type="submit">Revoke</button></footer>
            </form></dialog>` : ""}
        </section>`;

    const about = html`<dl class="kv small">
      <dt>Owner</dt><dd>${d.owner ? html`${d.owner.name} <span class="muted">(${d.owner.email})</span>` : "–"}</dd>
      ${editable ? "" : html`<dt>Folder</dt><dd>${d.folder ? d.folder.name : html`<span class="muted" aria-label="None">–</span>`}</dd>`}
      <dt>Source</dt><dd>${d.template ? html`<a href="/templates/${d.template.id}">template v${d.template.version}</a>${d.source === "inline" ? html` <span class="muted">· text edited</span>` : ""}` : "inline"}</dd>
      <dt>Revision</dt><dd class="mono">${d.revision.slice(0, 20)}…</dd>
      ${editable ? "" : html`<dt>Font</dt><dd>${CONTRACT_FONTS[d.font].label}</dd>`}
      ${editable ? "" : html`<dt>Reminders</dt><dd>${d.reminders ? "Every 3 business days" : "Off"}</dd>`}
      ${d.approved_by ? html`<dt>Approved by</dt><dd>${d.approved_by}</dd>` : ""}
      ${d.message ? html`<dt>Message</dt><dd>${d.message}</dd>` : ""}
      <dt>Created</dt><dd>${when(d.created_at)}</dd>
      ${d.sent_at ? html`<dt>Sent</dt><dd>${when(d.sent_at)}</dd>` : ""}
      ${d.expires_at ? html`<dt>Expires</dt><dd>${when(d.expires_at)}</dd>` : editable ? "" : html`<dt>Expires</dt><dd>${d.expires_in_days} days after sending</dd>`}
      ${d.completed_at ? html`<dt>Signed</dt><dd>${when(d.completed_at)}</dd>` : ""}
      ${d.revoked_at ? html`<dt>Revoked</dt><dd>${when(d.revoked_at)}${d.revoke_reason ? html` – ${d.revoke_reason}` : ""}</dd>` : ""}
      ${Object.keys(d.metadata).length ? html`<dt>Metadata</dt><dd class="mono">${JSON.stringify(d.metadata)}</dd>` : ""}
    </dl>`;

    const signerList = html`${d.signers.map((s) => html`<div class="signer-item"><div class="spread"><div class="row" style="gap:10px;flex-wrap:nowrap">${avatar(ctx, account.config.branding.avatars, s.name, s.email)}<div><strong>${s.name || s.key}</strong><div class="tiny muted">${s.email} · <code>${s.key}</code> · order ${s.order}${s.reminders_sent ? ` · ${s.reminders_sent} ${s.reminders_sent === 1 ? "reminder" : "reminders"}` : ""}</div></div></div>${badge(s.status)}</div>
      ${s.decline_reason ? html`<div class="small">Reason: “${s.decline_reason}”</div>` : ""}
      ${manage && active && (s.status === "notified" || s.status === "viewed") ? html`<form method="post" action="/documents/${d.id}/signers/${s.key}/resend" class="inline">${csrfInput(csrf)}<button type="submit" class="outline small" style="margin-top:6px">Resend link</button></form>` : ""}
    </div>`)}`;

    const activity = html`<ul class="timeline">${events.map((e) => html`<li>${eventIcon(e.type)}<div><span class="tl-actor">${e.type}</span> <span class="muted">· ${e.actor_label}</span><time datetime="${e.created_at}">${when(e.created_at)}</time></div></li>`)}</ul>`;

    const tab = (key: string, label: string) => html`<button type="button" role="tab" id="tab-${key}">${label}</button>`;
    const tabs = editable
      ? html`<form method="post" action="/documents/${d.id}/edit" class="draft-form">${csrfInput(csrf)}
          <ot-tabs>
            <div role="tablist" aria-label="Document">${tab("fill", "Fill")}${tab("signers", "Signers")}${tab("settings", "Settings")}${tab("activity", "Activity")}</div>
            <div role="tabpanel" aria-labelledby="tab-fill">
              ${valueFields.length ? valueFields.map((f) => valueInput(f, d.values[f.name!])) : html`<p class="small muted">This document has no values to fill in. Its signers fill in their own fields while signing.</p>`}
            </div>
            <div role="tabpanel" aria-labelledby="tab-signers">${signerRows(d.signers.map((s) => ({ key: s.key, name: s.name, email: s.email, order: s.order })), d.source === "template")}${d.source === "inline" ? html`<button type="button" class="outline small" id="add-signer" style="margin-top:8px">Add signer</button>` : ""}</div>
            <div role="tabpanel" aria-labelledby="tab-settings">
              <div data-field><label for="f-title">Title</label><input id="f-title" type="text" name="title" value="${d.title}"></div>
              <div class="inline-fields">
                <div data-field><label for="f-expires_in_days">Expires after (days)</label><input id="f-expires_in_days" type="number" min="1" max="365" name="expires_in_days" value="${d.expires_in_days}"></div>
                <div data-field><label for="f-font">Font</label><select id="f-font" name="font">${CONTRACT_FONT_NAMES.map((f) => html`<option value="${f}" ${d.font === f ? "selected" : ""}>${CONTRACT_FONTS[f].label}</option>`)}</select></div>
              </div>
              <input type="hidden" name="reminders_field" value="1">
              <label class="check"><input type="checkbox" name="reminders" ${d.reminders ? "checked" : ""}> Remind signers every 3 business days</label>
              ${docFolders.length ? html`<div data-field><label for="f-folder">Folder</label>${folderSelect("f-folder", docFolders, d.folder?.id)}</div>` : ""}
              <h3 class="panel-sub">About</h3>${about}
            </div>
            <div role="tabpanel" aria-labelledby="tab-activity">${activity}</div>
          </ot-tabs>
          <div class="panel-save"><button type="submit" class="w-full">Save draft</button></div>
        </form>`
      : html`<ot-tabs>
          <div role="tablist" aria-label="Document">${tab("signers", "Signers")}${tab("details", "Details")}${tab("activity", "Activity")}</div>
          <div role="tabpanel" aria-labelledby="tab-signers">${signerList}</div>
          <div role="tabpanel" aria-labelledby="tab-details">${about}</div>
          <div role="tabpanel" aria-labelledby="tab-activity">${activity}</div>
        </ot-tabs>`;

    // Editing an inline draft's text: the editor on the left, the live preview on the right.
    if (editingText) {
      return page(
        c,
        `Edit ${d.title}`,
        "documents",
        html`<script src="${asset("vendor/overtype.js")}" defer></script>
        <div class="workspace editing editor-scope">
          <section class="edit-pane" aria-label="Text">
            ${head}${opts.error ?? ""}
            <form method="post" action="/documents/${d.id}/text" class="text-form">${csrfInput(csrf)}
              <label for="f-content" class="sr-only">Markdown</label>
              <textarea id="f-content" class="code" name="content" autocapitalize="none" autocorrect="off" spellcheck="false" data-preview-source data-font="${d.font}" data-ot-padding="24px">${row!.source}</textarea>
              <footer class="edit-bar"><button type="submit" class="main-action">Save text</button><a class="button ghost" href="/documents/${d.id}">Cancel</a><span class="small muted">Saving makes a new revision. You'll check it before sending.</span></footer>
            </form>
          </section>
          <section class="preview-pane zoomable" aria-label="Preview"><div data-preview-target aria-live="polite">${markdownPreview(row!.source, d.font)}</div>${zoomControls()}</section>
        </div>`,
        undefined,
        FULL,
      );
    }

    return page(
      c,
      d.title,
      "documents",
      html`<div class="workspace">
        <div class="canvas zoomable">${head}${opts.error ?? ""}${canvas}${zoomControls()}</div>
        <aside class="doc-panel" aria-label="Document panel">${sendBlock}${tabs}</aside>
      </div>`,
      account.config.inline_documents === "needs_approval" && inlineNeedsApproval ? { kind: "warn", text: "This inline document needs approval before it can be sent." } : undefined,
      FULL,
    );
  };

  app.get("/documents/:id", (c) => documentPage(c, c.req.param("id")));

  // Draft editing now happens on the document page.
  app.get("/documents/:id/edit", (c) => c.redirect(`/documents/${c.req.param("id")}`));

  // Inline drafts: save the Markdown from the editor on the document page.
  app.post("/documents/:id/text", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await docs.updateDocument(ctx, c.get("user"), id, { content: str(b, "content") });
      return c.redirect(`/documents/${id}?msg=saved`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return documentPage(c, id, { error: alert("bad", html`${e.message}${issuesList(e.issues)}`) });
    }
  });

  // Template drafts: turn into an inline draft so the text can change (after a warning on the page).
  app.post("/documents/:id/to-inline", async (c) => {
    const id = c.req.param("id");
    try {
      await docs.convertToInline(ctx, c.get("user"), id);
      return c.redirect(`/documents/${id}?edit=text`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return documentPage(c, id, { error: alert("bad", e.message) });
    }
  });

  app.post("/documents/:id/edit", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.parseBody()) as FormBody;
    const row = await docs.loadDocument(ctx.db, id);
    const content = row.source_kind === "inline" && "content" in b ? str(b, "content") : undefined;
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
        ...(str(b, "font") ? { font: str(b, "font") } : {}),
        // Only the draft's Settings tab has the checkbox. The Markdown editor's form leaves it as it is.
        ...("reminders_field" in b ? { reminders: str(b, "reminders") === "on" } : {}),
      });
      if ("folder_id" in b && (str(b, "folder_id") || null) !== row.folder_id) await docs.moveDocument(ctx, c.get("user"), id, str(b, "folder_id") || null);
      return c.redirect(`/documents/${id}?msg=saved`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return documentPage(c, id, { error: alert("bad", html`${e.message}${issuesList(e.issues)}`) });
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
        const hit = e.code === "LIMIT_REACHED" ? await limitReached(ctx) : null;
        if (hit) return page(c, "Limit reached", "documents", html`${limitAlert(hit)}<a class="button outline" href="${back}">Back</a>`);
        return page(c, "Error", "documents", html`${alert("bad", html`${e.message}${e.issues.length ? issuesList(e.issues) : ""}`)}<a class="button outline" href="${back}">Back</a>`);
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

  // ---- Folders ----

  const folderList = (kind: string) => (kind === "template" ? "/templates" : "/documents");
  const folderAction = (path: string, fn: (c: Context<Env>, b: FormBody) => Promise<string>) =>
    app.post(path, async (c) => {
      const b = (await c.req.parseBody()) as FormBody;
      try {
        return c.redirect(await fn(c, b));
      } catch (e) {
        if (!(e instanceof SignedError)) throw e;
        const back = folderList(str(b, "kind"));
        return page(c, "Folders", back.slice(1), html`${alert("bad", e.message)}<a class="button outline" href="${back}">Back</a>`);
      }
    });
  folderAction("/folders", async (c, b) => {
    const f = await folders.createFolder(ctx, c.get("user"), folders.checkKind(str(b, "kind")), str(b, "name"));
    return folderList(f.kind);
  });
  folderAction("/folders/:id/rename", async (c, b) => {
    const f = await folders.renameFolder(ctx, c.get("user"), c.req.param("id")!, str(b, "name"));
    return str(b, "back") === "folder" ? `${folderList(f.kind)}?folder=${f.id}` : folderList(f.kind);
  });
  folderAction("/folders/:id/delete", async (c) => {
    const { folder } = await folders.deleteFolder(ctx, c.get("user"), c.req.param("id")!);
    return `${folderList(folder.kind)}?msg=folder_deleted`;
  });
  folderAction("/documents/:id/move", async (c, b) => {
    await docs.moveDocument(ctx, c.get("user"), c.req.param("id")!, str(b, "folder_id") || null);
    return localBack(str(b, "back")) ?? `/documents/${c.req.param("id")}?msg=saved`;
  });
  folderAction("/templates/:id/move", async (c, b) => {
    await tpl.moveTemplate(ctx, c.get("user"), c.req.param("id")!, str(b, "folder_id") || null);
    return localBack(str(b, "back")) ?? `/templates/${c.req.param("id")}?msg=saved`;
  });

  // ---- Templates ----

  app.get("/templates", async (c) => {
    const archived = c.req.query("archived") === "1";
    const tplFolders = await folders.listFolders(ctx, "template");
    const current = tplFolders.find((f) => f.id === c.req.query("folder"));
    if (c.req.query("folder") && !current) return c.redirect("/templates");
    const folder = current ? current.id : undefined;
    const listUrl = hereWithout(c.req.url, "msg");
    const list = await tpl.listTemplates(ctx, { archived, ...(folder ? { folder } : {}) });
    const pending = list.filter((t) => t.versions.some((v) => v.approval_status === "pending_approval"));
    return page(c, "Templates", "templates", html`
      ${folderHead("Templates", "/templates", current, can(c.get("user"), "templates.create") ? newMenu("template", withQuery("/templates/new", { folder: current?.id }), can(c.get("user"), "templates.manage") && !current, c.get("csrf")) : "")}
      ${pending.length && !archived ? html`${alert("warn", html`<strong>${pending.length} template${pending.length > 1 ? "s" : ""} waiting for approval.</strong> ${can(c.get("user"), "templates.approve") ? "Agents and teammates can draft templates, but only an owner can approve them." : "An owner must approve them before they can be used."}`)}` : ""}
      ${!current && !archived ? folderGrid("template", tplFolders, await folders.folderCounts(ctx, "template"), (id) => withQuery("/templates", { folder: id }), can(c.get("user"), "templates.manage"), c.get("csrf")) : ""}
      <div class="card table">
      ${list.length === 0 ? (current ? empty("Nothing in this folder") : archived ? empty("Nothing archived") : empty("No templates yet", html`<a href="/templates/new">Create your first template</a>.`))
        : html`<table class="stack"><thead><tr><th>Name</th><th>ID</th><th>Folder</th><th>Live</th><th>Latest</th><th>Created via</th></tr></thead><tbody>
          ${list.map((t) => html`<tr><td class="cell-main"><a class="item-cell" href="/templates/${t.id}">${icon("template")}<div><strong>${t.name}</strong>${t.description ? html`<div class="tiny muted">${t.description}</div>` : ""}</div></a></td>
            <td class="nowrap cell-meta lead">${copyValue(t.id)}</td>
            <td class="cell-meta${t.folder ? "" : " hide-sm"}">${folderCell("template", t, tplFolders, can(c.get("user"), "templates.manage"), c.get("csrf"), listUrl)}</td>
            <td class="cell-meta"><span class="m-only">Live </span>${t.approved_version ? html`v${t.approved_version}` : html`<span class="muted">none</span>`}</td>
            <td class="cell-status"><div class="row">v${t.current_version} ${badge(t.versions[0]!.approval_status)}</div></td>
            <td class="cell-meta${t.created_via === "ui" ? " hide-sm" : ""}"><span class="m-only">via </span>${t.created_via === "ui" ? "UI" : html`<span class="badge" data-variant="warning">${t.created_via.toUpperCase()}</span>`}</td></tr>`)}
        </tbody></table>`}
      </div>
      <p><a class="small" href="${archived ? "/templates" : withQuery("/templates", { folder: current?.id, archived: "1" })}">${archived ? "Back to active templates" : "View archive"}</a></p>`);
  });

  app.get("/templates/new", async (c) => {
    requirePermission(c.get("user"), "templates.create");
    return page(c, "New template", "templates", templateForm(c.get("csrf"), await accountFont(), { name: "", description: "", source: EXAMPLE_TEMPLATE, folders: await folders.listFolders(ctx, "template"), folderId: c.req.query("folder") ?? null }, can(c.get("user"), "templates.approve"), true), undefined, FULL);
  });

  // Start from an existing contract: convert it to Markdown, then edit it like any new template.
  app.post("/templates/import", async (c) => {
    requirePermission(c.get("user"), "templates.create");
    const b = (await c.req.parseBody()) as FormBody;
    const approve = can(c.get("user"), "templates.approve");
    try {
      const file = b.file;
      if (!(file instanceof File)) throw new SignedError("INVALID_REQUEST", "Choose a file to import");
      const doc = await importDocument(file.name, new Uint8Array(await file.arrayBuffer()));
      return page(c, "New template", "templates", templateForm(c.get("csrf"), await accountFont(), { name: doc.title, description: "", source: doc.markdown, folders: await folders.listFolders(ctx, "template") }, approve, false, alert("info", html`<strong>Converted from ${file.name}.</strong> Read it carefully: conversion can change layout. Then replace the blanks with placeholders, such as <code>{{$client_name:text}}</code> or <code>{{client.signature:signature}}</code>.`)), undefined, FULL);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "New template", "templates", templateForm(c.get("csrf"), await accountFont(), { name: "", description: "", source: EXAMPLE_TEMPLATE, folders: await folders.listFolders(ctx, "template") }, approve, true, alert("bad", e.message)), undefined, FULL);
    }
  });

  app.post("/templates", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const input = { name: str(b, "name"), description: str(b, "description"), source: str(b, "source").replace(/\r\n/g, "\n"), ...(str(b, "folder_id") ? { folder_id: str(b, "folder_id") } : {}) };
    try {
      const t = await tpl.createTemplate(ctx, c.get("user"), { ...input, approve: str(b, "approve") === "1" });
      return c.redirect(`/templates/${t.id}?msg=created`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "New template", "templates", templateForm(c.get("csrf"), await accountFont(), { ...input, folders: await folders.listFolders(ctx, "template"), folderId: input.folder_id ?? null }, can(c.get("user"), "templates.approve"), false, alert("bad", html`${e.message}${issuesList(e.issues)}`)), undefined, FULL);
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
    const user = c.get("user");
    const pending = v.approval_status === "pending_approval";
    const canUse = !!t.approved_version && can(user, "documents.create");
    const tab = (key: string, label: string) => html`<button type="button" role="tab" id="tab-${key}">${label}</button>`;
    // Like a document: the pages on a canvas, and a side panel with the main action and the details.
    return page(
      c,
      t.name,
      "templates",
      html`<div class="workspace">
        <div class="canvas zoomable">
          <header class="doc-head">
            <div><h1>${t.name}</h1><div class="row small muted">${t.description ? html`<span>${t.description}</span>` : ""}<span>v${v.version}</span> ${badge(v.approval_status)} ${t.archived ? badge("archived") : ""}</div></div>
            <div class="row">
              ${can(user, "templates.create") ? html`<a class="button outline small" href="/templates/${t.id}/edit">${icon("pencil")} New version</a>` : ""}
              ${can(user, "templates.manage") ? html`<form method="post" action="/templates/${t.id}/${t.archived ? "unarchive" : "archive"}" class="inline">${csrfInput(csrf)}<button type="submit" class="outline small">${t.archived ? "Unarchive" : "Archive"}</button></form>` : ""}
            </div>
          </header>
          ${previewArticle(body, v.fields, (await getAccount(ctx)).config.branding.contract_font)}
          ${zoomControls()}
        </div>
        <aside class="doc-panel" aria-label="Template panel">
          ${pending
            ? html`<section class="panel-block" aria-labelledby="approval"><h2 id="approval">Waiting for approval</h2>
                <p class="small">Version ${v.version} was created by <strong>${names.get(v.created_by) ?? v.created_by}</strong>. Read it carefully: once approved, people and agents can send it.</p>
                ${can(user, "templates.approve")
                  ? html`<form method="post" action="/templates/${t.id}/versions/${v.version}/approve" data-confirm="Approve version ${v.version}? Agents will be able to send it.">${csrfInput(csrf)}<button type="submit" class="w-full main-action">Approve version ${v.version}</button></form>`
                  : html`<p class="small muted">Only an owner can approve it.</p>`}
              </section>`
            : canUse
              ? html`<section class="panel-block" aria-labelledby="use"><h2 id="use">Use this template</h2>
                  <a class="button w-full main-action" href="/documents/new?template=${t.id}">Use template</a>
                  <p class="tiny muted" style="margin:6px 0 0">Starts a draft from version ${t.approved_version}. You fill in the values and signers, then check it before sending.</p></section>`
              : html`<section class="panel-block row-stretch" aria-labelledby="status"><h2 id="status">${t.approved_version ? `Version ${t.approved_version} is approved` : "Not approved yet"}</h2></section>`}
          <ot-tabs>
            <div role="tablist" aria-label="Template">${tab("details", "Details")}${tab("fields", "Fields")}${tab("versions", "Versions")}${tab("source", "Source")}</div>
            <div role="tabpanel" aria-labelledby="tab-details">
              ${agentStrip(t, v.fields)}
              <h3 class="panel-sub">About</h3>
              <dl class="kv small">
                <dt>Folder</dt><dd>${can(user, "templates.manage")
                  ? html`<form method="post" action="/templates/${t.id}/move" class="row move-form">${csrfInput(csrf)}<input type="hidden" name="kind" value="template"><label for="move-folder" class="sr-only">Folder</label>${folderSelect("move-folder", await folders.listFolders(ctx, "template"), t.folder?.id)}<button type="submit" class="outline small">Move</button></form>`
                  : t.folder ? t.folder.name : html`<span class="muted" aria-label="None">–</span>`}</dd>
                <dt>Approved</dt><dd>${t.approved_version ? `v${t.approved_version}` : html`<span class="muted">none</span>`}</dd>
                <dt>Latest</dt><dd>v${t.current_version}</dd>
                <dt>Created via</dt><dd>${t.created_via === "ui" ? "Web UI" : t.created_via.toUpperCase()}</dd>
              </dl>
            </div>
            <div role="tabpanel" aria-labelledby="tab-fields">${fieldsPanel(v.fields)}</div>
            <div role="tabpanel" aria-labelledby="tab-versions">
              ${t.versions.map((x) => html`<div class="spread" style="margin-bottom:8px"><a href="/templates/${t.id}?v=${x.version}">${x.version === shown ? html`<strong>v${x.version}</strong>` : `v${x.version}`}</a>${badge(x.approval_status)}</div>
                <div class="small muted" style="margin:-6px 0 10px">${when(x.created_at)} · ${names.get(x.created_by) ?? x.created_by}${x.approved_by ? html`<br>Approved by ${names.get(x.approved_by) ?? x.approved_by}` : ""}</div>`)}
            </div>
            <div role="tabpanel" aria-labelledby="tab-source"><pre class="source-pre">${v.source}</pre></div>
          </ot-tabs>
        </aside>
      </div>`,
      undefined,
      FULL,
    );
  });

  app.get("/templates/:id/edit", async (c) => {
    const id = c.req.param("id");
    const t = await tpl.getTemplate(ctx, id);
    const v = await tpl.getTemplateVersion(ctx, id);
    requirePermission(c.get("user"), "templates.create");
    return page(c, `Edit ${t.name}`, "templates", templateForm(c.get("csrf"), await accountFont(), { id, name: t.name, description: t.description, source: v.source }, can(c.get("user"), "templates.approve")), undefined, FULL);
  });

  app.post("/templates/:id/edit", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.parseBody()) as FormBody;
    // A new version changes the text, never the name (renaming would be its own, explicit action).
    const input = { name: (await tpl.getTemplate(ctx, id)).name, description: str(b, "description"), source: str(b, "source").replace(/\r\n/g, "\n") };
    try {
      await tpl.addTemplateVersion(ctx, c.get("user"), id, { description: input.description, source: input.source, approve: str(b, "approve") === "1" });
      return c.redirect(`/templates/${id}?msg=saved`);
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Edit template", "templates", templateForm(c.get("csrf"), await accountFont(), { id, ...input }, can(c.get("user"), "templates.approve"), false, alert("bad", html`${e.message}${issuesList(e.issues)}`)), undefined, FULL);
    }
  });

  app.post("/templates/:id/versions/:v/approve", async (c) => {
    const id = c.req.param("id");
    await tpl.approveTemplateVersion(ctx, c.get("user"), id, Number(c.req.param("v")));
    return c.redirect(`/templates/${id}?v=${c.req.param("v")}&msg=approved`);
  });
  app.post("/templates/:id/archive", async (c) => {
    await tpl.setTemplateArchived(ctx, c.get("user"), c.req.param("id"), true);
    return c.redirect(`/templates/${c.req.param("id")}?msg=archived`);
  });
  app.post("/templates/:id/unarchive", async (c) => {
    await tpl.setTemplateArchived(ctx, c.get("user"), c.req.param("id"), false);
    return c.redirect(`/templates/${c.req.param("id")}?msg=unarchived`);
  });

  // ---- Settings ----

  app.get("/settings", async (c) => {
    const account = await getAccount(ctx);
    const user = c.get("user");
    const admin = can(user, "settings.manage");
    const csrf = c.get("csrf");
    return page(c, "Settings", "settings", html`
      <div class="page-head"><h1>Settings</h1></div>
      ${admin ? settingsTabs("general") : ""}

      <form method="post" action="/settings/profile" class="card" aria-labelledby="your-profile">${csrfInput(csrf)}<header><h2 id="your-profile">Your profile</h2></header>
        <div class="inline-fields" style="grid-template-columns:1fr 1fr">
          <div data-field><label for="f-name">Name</label><input id="f-name" type="text" name="name" value="${user.name}" required></div>
          <div data-field><label for="f-profile-email">Email</label><input id="f-profile-email" type="email" value="${user.label}" disabled></div>
        </div>
        <p class="small muted">Role: <strong>${ROLE_LABELS[user.role]}</strong>. Signers see your name, email, and avatar on documents you send, and their replies come to you.</p>
        <button type="submit">Save</button>
      </form>

      <form method="post" action="/settings/theme" class="card" aria-labelledby="theme-title" data-theme-form>${csrfInput(csrf)}<header><h2 id="theme-title">Theme</h2></header>
        <fieldset aria-describedby="theme-hint"><legend class="sr-only">Theme</legend>
          <div class="row" style="gap:10px">${(["system", "light", "dark"] as const).map((t) => html`<label class="font-choice"><input type="radio" name="theme" value="${t}" ${(user.theme ?? "system") === t ? "checked" : ""}> ${{ system: "System", light: "Light", dark: "Dark" }[t]}</label>`)}</div>
          <small data-hint id="theme-hint">Changes at once. For this admin app only: signing pages follow each signer's device, and PDFs are always white.</small></fieldset>
        <noscript><button type="submit">Save theme</button></noscript>
      </form>

      ${admin ? html`<form method="post" action="/settings/account" class="card" aria-labelledby="account">${csrfInput(csrf)}<header><h2 id="account">Account</h2></header>
        <div data-field><label for="f-account-name">Company name</label><input id="f-account-name" type="text" name="name" value="${account.name}"></div>
        <div data-field><label for="f-inline_documents">Inline documents <span class="muted">· documents written without an approved template</span></label>
          <select id="f-inline_documents" name="inline_documents">${(["allowed", "needs_approval", "disabled"] as const).map((o) => html`<option value="${o}" ${account.config.inline_documents === o ? "selected" : ""}>${{ allowed: "Allowed", needs_approval: "Need approval in the UI", disabled: "Disabled" }[o]}</option>`)}</select></div>
        <div class="inline-fields" style="grid-template-columns:1fr 1fr 1fr">
          <div data-field><label for="f-default_expiry_days">Default expiry (days)</label><input id="f-default_expiry_days" type="number" min="1" max="365" name="default_expiry_days" value="${account.config.default_expiry_days}"></div>
          <div data-field><label for="f-timezone">Timezone</label><input id="f-timezone" type="text" name="timezone" value="${account.config.timezone}"></div>
          <div data-field><label for="f-locale">Locale</label><input id="f-locale" type="text" name="locale" value="${account.config.locale}"></div>
        </div>
        <label class="check"><input type="checkbox" name="reminders" ${account.config.reminders ? "checked" : ""}> Remind signers every 3 business days <span class="muted">· default for new documents. Reminders reuse the signer's link.</span></label>
        <label class="check"><input type="checkbox" name="attach_zip" ${account.config.attach_zip ? "checked" : ""}> Attach the evidence ZIP to completion emails (the PDF is always attached)</label>
        <button type="submit" style="margin-top:12px">Save</button>
      </form>

      ${ctx.config.hosted ? "" : html`<section class="card" aria-labelledby="signing-key"><header><h2 id="signing-key">Signing key</h2><p>Completed packages are signed with this key. Back up <code>${ctx.config.dataDir}/keys</code> together with the database.</p></header>
        <dl class="kv small"><dt>Key ID</dt><dd class="mono">${ctx.keys.info.kid}</dd><dt>Public keys</dt><dd><a href="/.well-known/signed-md-keys.json">/.well-known/signed-md-keys.json</a></dd></dl></section>`}` : ""}

      ${!ctx.config.allowEmailLogin ? "" : html`<form method="post" action="/settings/password" class="card" aria-labelledby="password">${csrfInput(csrf)}<header><h2 id="password">Password</h2></header>
        <div data-field><label for="f-password">New password <span class="muted">· at least 10 characters</span></label><input id="f-password" type="password" name="password" autocomplete="new-password"></div>
        <button type="submit" class="outline">Change password</button></form>`}`);
  });

  // Agents: connect over MCP or REST, API keys, and webhooks. Signed.md is built for this.
  app.get("/agentic", async (c) => {
    const account = await getAccount(ctx);
    const user = c.get("user");
    const admin = can(user, "settings.manage");
    const keys = await listApiKeys(ctx, user);
    const deliveries = admin ? await listDeliveries(ctx, 10) : [];
    const csrf = c.get("csrf");
    const newKey = c.req.query("key");
    return page(c, "Agents", "agentic", html`
      <div class="page-head"><div><h1>Agents</h1><p class="muted" style="margin:4px 0 0">Your agents prepare and send documents over MCP or REST, as you. People still approve templates and sign.</p></div></div>
      ${newKey ? html`${alert("ok", html`<strong>New API key.</strong> Copy it now. It will not be shown again.<pre>${newKey}</pre><button type="button" class="outline small" data-copy="${newKey}">Copy</button>`)}` : ""}
      <section class="card" aria-labelledby="agent-skill"><header><h2 id="agent-skill">Set up your agent</h2><p>Paste this into any agent (Claude, ChatGPT, Cursor and others). It installs the Signed.md skill and walks you through connecting.</p></header>
        ${copyValue(agentSetupPrompt(ctx.config.publicUrl, ctx.config.hosted), true, true)}
        <p class="tiny muted" style="margin:10px 0 0">The skill: <a class="text-link" href="/skill.md" target="_blank" rel="noopener">${ctx.config.publicUrl}/skill.md</a> · click the prompt to copy it</p>
      </section>
      <section class="card" aria-labelledby="connect-an-agent"><header><h2 id="connect-an-agent">Connect using MCP / API</h2></header>
        <p>Create an API key, then connect your agent over MCP or REST. The agent acts as you, with your role${user.role === "member" ? ": it sees and sends only your documents" : user.role === "viewer" ? ": it can only read" : ""}.</p>
        <dl class="kv small"><dt>MCP endpoint</dt><dd>${copyValue(`${ctx.config.publicUrl}/mcp`)}</dd>
          <dt>REST API</dt><dd>${copyValue(`${ctx.config.publicUrl}/v1`)}</dd>
          <dt>OpenAPI</dt><dd><a class="text-link" href="/openapi.json">/openapi.json</a></dd></dl>
        ${copyValue(`claude mcp add --transport http signed-md ${ctx.config.publicUrl}/mcp --header "Authorization: Bearer YOUR_API_KEY"`, true)}
      </section>


      <section class="card" aria-labelledby="api-keys"><header><h2 id="api-keys">${admin ? "API keys" : "Your API keys"}</h2></header>
        ${keys.length ? html`<div class="table"><table><thead><tr><th>Label</th>${admin ? html`<th>Owner</th>` : ""}<th>Key</th><th>Last used</th><th></th></tr></thead><tbody>
          ${keys.map((k) => html`<tr><td>${k.label}</td>${admin ? html`<td>${k.owner ? k.owner.name : html`<span class="muted">–</span>`}</td>` : ""}<td class="mono">${k.prefix}…</td><td>${when(k.last_used_at)}</td>
            <td style="text-align:right">${k.revoked_at ? badge("revoked") : html`<form method="post" action="/settings/keys/${k.id}/revoke" data-confirm="Revoke this key? Agents using it will stop working.">${csrfInput(csrf)}<button data-variant="danger" type="submit" class="small">Revoke</button></form>`}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No API keys yet.</p>`}
        <form method="post" action="/settings/keys" class="row" style="margin-top:12px">${csrfInput(csrf)}<input type="text" name="label" placeholder="Label, e.g. Sales agent" aria-label="Key label" style="max-width:280px"><button type="submit" class="outline">Create API key</button></form>
      </section>

      ${admin ? html`<form method="post" action="/settings/webhook" class="card" aria-labelledby="webhook">${csrfInput(csrf)}<header><h2 id="webhook">Webhook</h2><p>Events: ${WEBHOOK_EVENTS.join(", ")}. Requests are signed with HMAC-SHA256 in the <code>Signed-Md-Signature</code> header.</p></header>
        <div data-field><label for="f-url">URL</label><input id="f-url" type="url" name="url" value="${account.config.webhook_url ?? ""}" placeholder="https://example.com/hooks/signed"></div>
        <fieldset><legend>Signing secret</legend><div class="row"><button type="button" class="copy-value secret" data-copy="${account.config.webhook_secret}" data-copy-flash aria-label="Copy the signing secret (hover or focus to show it)">${account.config.webhook_secret}</button> <label class="check"><input type="checkbox" name="rotate"> Rotate</label></div></fieldset>
        <button type="submit">Save</button>
        ${deliveries.length ? html`<h3 style="margin-top:18px">Recent deliveries</h3><div class="table"><table><tbody>${deliveries.map((d) => html`<tr><td>${d.event_type}</td><td>${badge(d.status)}</td><td>${d.last_status_code ?? ""} ${d.last_error ? html`<span class="muted">${d.last_error.slice(0, 80)}</span>` : ""}</td><td class="nowrap">${when(d.created_at)}</td></tr>`)}</tbody></table></div>` : ""}
      </form>` : ""}
    `);
  });

  app.post("/settings/keys", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const { key } = await createApiKey(ctx, c.get("user"), str(b, "label"));
    return c.redirect(`/agentic?key=${encodeURIComponent(key)}`);
  });
  app.post("/settings/keys/:id/revoke", async (c) => {
    await revokeApiKey(ctx, c.get("user"), c.req.param("id"));
    return c.redirect("/agentic?msg=saved");
  });
  app.post("/settings/account", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await updateAccount(ctx, c.get("user"), {
        name: str(b, "name"),
        config: {
          inline_documents: str(b, "inline_documents") as InlineDocumentsSetting,
          default_expiry_days: Number(str(b, "default_expiry_days")),
          timezone: str(b, "timezone").trim() || "UTC",
          locale: str(b, "locale").trim() || "en-US",
          attach_zip: str(b, "attach_zip") === "on",
          reminders: str(b, "reminders") === "on",
        },
      });
      return c.redirect("/settings?msg=saved");
    } catch (e) {
      return page(c, "Settings", "settings", html`${alert("bad", html`${(e as Error).message}`)}<a class="button outline" href="/settings">Back</a>`);
    }
  });
  app.post("/settings/webhook", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await updateAccount(ctx, c.get("user"), { config: { webhook_url: str(b, "url").trim() || null, ...(str(b, "rotate") === "on" ? { webhook_secret: newWebhookSecret() } : {}) } });
      return c.redirect("/agentic?msg=saved");
    } catch (e) {
      return page(c, "Agents", "agentic", html`${alert("bad", html`${(e as Error).message}`)}<a class="button outline" href="/agentic">Back</a>`);
    }
  });
  // The theme applies at once: app.js swaps the colour scheme and saves it here in the background.
  app.post("/settings/theme", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const user = c.get("user");
    await team.updateProfile(ctx, user, { name: user.name, theme: str(b, "theme") });
    return c.req.header("accept")?.includes("application/json") ? c.json({ ok: true }) : c.redirect("/settings?msg=profile");
  });
  app.post("/settings/profile", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await team.updateProfile(ctx, c.get("user"), { name: str(b, "name"), ...(str(b, "theme") ? { theme: str(b, "theme") } : {}) });
      return c.redirect("/settings?msg=profile");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Settings", "settings", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/settings">Back</a>`);
    }
  });
  app.post("/settings/password", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await changePassword(ctx, c.get("user").id, str(b, "password"));
      return c.redirect("/settings?msg=password");
    } catch (e) {
      return page(c, "Settings", "settings", html`${alert("bad", html`${(e as Error).message}`)}<a class="button outline" href="/settings">Back</a>`);
    }
  });

  // ---- Team ----

  app.get("/team", async (c) => {
    const user = c.get("user");
    requirePermission(user, "team.manage");
    const [members, invitations, account] = await Promise.all([team.listMembers(ctx), team.listInvitations(ctx), getAccount(ctx)]);
    const csrf = c.get("csrf");
    const isOwner = user.role === "owner";
    const assignable = ROLES.filter((r) => r !== "owner" || isOwner);
    return page(c, "Team", "team", html`
      <div class="page-head"><h1>Team</h1></div>
      <form method="post" action="/team/invite" class="card" aria-labelledby="invite-someone">${csrfInput(csrf)}<header><h2 id="invite-someone">Invite someone</h2></header>
        <div class="invite-row">
          <div data-field><label for="f-email">Email</label><input id="f-email" type="email" name="email" required placeholder="name@company.com"></div>
          <div data-field><label for="f-role">Role</label><select id="f-role" name="role">${assignable.map((r) => html`<option value="${r}" ${r === "member" ? "selected" : ""}>${ROLE_LABELS[r]}</option>`)}</select></div>
          <button type="submit">Send invitation</button>
        </div>
        <details class="tiny link-details"><summary>What each role can do</summary>
          <table><tbody>
            ${ROLES.map((r) => html`<tr><td><strong>${ROLE_LABELS[r]}</strong></td><td>${ROLE_HELP[r]}</td></tr>`)}
          </tbody></table></details>
      </form>

      ${invitations.length ? html`<section class="card" aria-labelledby="pending-invitations"><header><h2 id="pending-invitations">Pending invitations</h2></header><div class="table"><table class="stack" style="--indent: 0px"><tbody>
        ${invitations.map((i) => html`<tr><td class="cell-main">${i.email}<div class="small muted">Invited by ${i.invited_by} · expires ${when(i.expires_at)}</div></td><td class="cell-meta lead">${ROLE_LABELS[i.role]}</td>
          <td style="text-align:right" class="nowrap cell-status">
            <form method="post" action="/team/invitations/${i.id}/resend" class="inline">${csrfInput(csrf)}<button type="submit" class="outline small">Resend</button></form>
            <form method="post" action="/team/invitations/${i.id}/revoke" class="inline">${csrfInput(csrf)}<button data-variant="danger" type="submit" class="small">Revoke</button></form></td></tr>`)}
      </tbody></table></div></section>` : ""}

      <div class="card table"><table class="stack" style="--indent: 50px"><thead><tr><th>Person</th><th>Role</th><th>Last login</th><th></th></tr></thead><tbody>
        ${members.map((m) => {
          const self = m.id === user.id;
          const locked = m.role === "owner" && !isOwner;
          return html`<tr>
            <td class="cell-main"><div class="row" style="gap:10px;flex-wrap:nowrap">${avatar(ctx, account.config.branding.avatars, m.name, m.email)}<div><strong>${m.name}</strong>${self ? html` <span class="muted small">(you)</span>` : ""}<div class="small muted">${m.email}</div></div></div></td>
            <td class="cell-meta lead">${self || locked || m.status !== "active"
              ? html`<span class="role-cell">${roleIcon(m.role)}${ROLE_LABELS[m.role]}</span>`
              : html`<button type="button" class="link-button role-cell" commandfor="role-${m.id}" command="show-modal" aria-label="Change role for ${m.name}, now ${ROLE_LABELS[m.role]}">${roleIcon(m.role)}${ROLE_LABELS[m.role]}${icon("chevronDown")}</button>
                ${roleDialog(m, assignable, csrf)}`}</td>
            <td class="nowrap cell-meta">${m.status === "active" ? html`<span class="m-only">Last login </span>${when(m.last_login_at)}` : badge("deactivated")}</td>
            <td style="text-align:right" class="cell-status">${self || locked ? ""
              : m.status === "active"
                ? html`<button type="button" class="ghost icon danger-icon" commandfor="deactivate-${m.id}" command="show-modal" aria-label="Deactivate ${m.name}" title="Deactivate">${icon("trash")}</button>
                  <dialog id="deactivate-${m.id}" closedby="any" aria-labelledby="deactivate-${m.id}-title" aria-describedby="deactivate-${m.id}-text">
                    <form method="post" action="/team/${m.id}/deactivate">${csrfInput(csrf)}
                      <header><h2 id="deactivate-${m.id}-title">Deactivate ${m.name}?</h2></header>
                      <p id="deactivate-${m.id}-text" class="small"><strong>${m.name}</strong> (${m.email}) will lose access at once, and their sessions and API keys will stop working. Their documents stay, and you can reactivate them later.</p>
                      <footer><button type="button" class="outline" commandfor="deactivate-${m.id}" command="close">Cancel</button><button type="submit" data-variant="danger">Deactivate</button></footer>
                    </form>
                  </dialog>`
                : html`<form method="post" action="/team/${m.id}/reactivate" class="inline">${csrfInput(csrf)}<button type="submit" class="outline small">Reactivate</button></form>`}</td>
          </tr>`;
        })}
      </tbody></table></div>
      <p class="small muted">People are never deleted. Deactivating someone ends their sessions and API keys at once. Their documents stay, and administrators can still manage them.</p>`);
  });

  const teamAction = (path: string, fn: (c: Context<Env>, b: FormBody) => Promise<string>) =>
    app.post(path, async (c) => {
      const b = (await c.req.parseBody()) as FormBody;
      try {
        return c.redirect(await fn(c, b));
      } catch (e) {
        if (!(e instanceof SignedError) || e.code === "PERMISSION_DENIED") throw e;
        return page(c, "Team", "team", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/team">Back</a>`);
      }
    });
  teamAction("/team/invite", async (c, b) => {
    await team.inviteMember(ctx, c.get("user"), { email: str(b, "email"), role: str(b, "role") });
    return "/team?msg=invited";
  });
  teamAction("/team/invitations/:id/resend", async (c) => {
    await team.resendInvitation(ctx, c.get("user"), c.req.param("id")!);
    return "/team?msg=invited";
  });
  teamAction("/team/invitations/:id/revoke", async (c) => {
    await team.revokeInvitation(ctx, c.get("user"), c.req.param("id")!);
    return "/team?msg=team";
  });
  teamAction("/team/:id/role", async (c, b) => {
    await team.changeRole(ctx, c.get("user"), c.req.param("id")!, str(b, "role"));
    return "/team?msg=team";
  });
  teamAction("/team/:id/deactivate", async (c) => {
    await team.deactivateMember(ctx, c.get("user"), c.req.param("id")!);
    return "/team?msg=team";
  });
  teamAction("/team/:id/reactivate", async (c) => {
    await team.reactivateMember(ctx, c.get("user"), c.req.param("id")!);
    return "/team?msg=team";
  });

  // ---- Activity ----

  app.get("/activity", async (c) => {
    requirePermission(c.get("user"), "activity.read");
    const before = c.req.query("before") || undefined;
    const after = c.req.query("after") || undefined;
    const { items, older, newer } = await listActivity(ctx.db, { limit: 50, ...(before ? { before } : after ? { after } : {}) });
    return page(c, "Activity", "activity", html`<div class="page-head"><h1>Activity</h1></div>
      <div class="card activity-card">${items.length === 0 ? empty("Nothing yet") : html`<ul class="timeline activity">
        ${items.map((i) => html`<li>${eventIcon(i.type)}<div><span class="tl-actor">${i.actor || "Signed.md"}</span> ${i.summary}${i.document ? html` · <a href="/documents/${i.document.id}">${i.document.title}</a>` : ""}<time datetime="${i.at}">${when(i.at)}</time></div></li>`)}
      </ul>`}</div>
      ${pager(c.req.url, "activity", newer, older)}`);
  });

  // ---- Branding ----

  app.get("/settings/branding", async (c) => {
    requirePermission(c.get("user"), "settings.manage");
    const account = await getAccount(ctx);
    const logo = account.config.branding.logo;
    const csrf = c.get("csrf");
    return page(c, "Branding", "settings", html`
      <div class="page-head"><h1>Settings</h1></div>
      ${settingsTabs("branding")}
      <div class="branding-grid">
        <div class="branding-settings">
          <form method="post" action="/settings/branding/logo" enctype="multipart/form-data" class="card" aria-labelledby="logo">${csrfInput(csrf)}<header><h2 id="logo">Logo</h2><p>Shown at the top of every email and on the signing pages. PNG or JPEG, up to 300 KB. A wide logo about 400 × 80 pixels works best.</p></header>
            ${logo ? html`<div class="logo-preview"><img src="/branding/logo?v=${logo.sha256.slice(0, 8)}" alt="Current logo"></div>` : html`<p class="muted">No logo. Emails show “${account.name}” instead.</p>`}
            <div class="row" style="margin-top:12px"><input type="file" name="logo" accept="image/png,image/jpeg" aria-label="Logo file" style="max-width:280px"><button type="submit">Upload</button></div>
          </form>
          ${logo ? html`<form method="post" action="/settings/branding/logo/remove" class="inline" style="display:block;margin:-6px 0 18px">${csrfInput(csrf)}<button type="submit" class="outline small">Remove logo</button></form>` : ""}
          <form method="post" action="/settings/branding/look" class="card" aria-labelledby="email-banner-and-avatars">${csrfInput(csrf)}<header><h2 id="email-banner-and-avatars">Email banner and avatars</h2></header>
            <div data-field><label for="banner_color">Banner colour</label>
              <div class="row"><input type="color" id="banner_color_picker" value="${account.config.branding.banner_color}" data-sync="banner_color" aria-label="Pick banner colour" class="color-swatch">
              <input type="text" id="banner_color" name="banner_color" value="${account.config.branding.banner_color}" pattern="#[0-9a-fA-F]{6}" aria-describedby="banner-hint" style="max-width:130px" class="mono"></div>
              <small data-hint id="banner-hint">Text and button colours adjust automatically for contrast.</small></div>
            <label class="check"><input type="checkbox" name="avatars" ${account.config.branding.avatars ? "checked" : ""}> <span>Show avatars in emails and in this app<br><span class="tiny muted">Pictures come from ${ctx.config.avatarProvider === "gravatar" ? "Gravatar" : "unavatar.io"}${!["https://unavatar.io", "https://gravatar.com/avatar"].includes(ctx.config.avatarBaseUrl) ? html` through <code>${new URL(ctx.config.avatarBaseUrl).host}</code>` : ""}. This shares ${ctx.config.avatarProvider === "gravatar" ? "a hash of each email address" : "email addresses"} with that service, and email clients load the pictures from it. Without a picture, initials are shown.</span></span></label>
            ${ctx.config.hosted
              ? html`<label class="check"><input type="checkbox" ${ctx.config.branding ? "checked" : ""} disabled> <span>Show “Powered by Signed.md” in emails and on signing pages<br><span class="tiny muted">${ctx.config.branding ? html`Included on your plan. <a class="text-link" href="${HOSTED_APP_URL}/billing">Upgrade</a> to remove it.` : "Removed on your plan."}</span></span></label>`
              : ""}
            <button type="submit" style="margin-top:12px">Save</button>
          </form>
          <form method="post" action="/settings/branding/message" class="card" aria-labelledby="message-to-signers">${csrfInput(csrf)}<header><h2 id="message-to-signers">Message to signers</h2><p>The default message in every signing email. You can change it each time you send. Agents can pass their own message too.</p></header>
            <div data-field><textarea name="message" aria-label="Default message to signers" aria-describedby="variables-hint" maxlength="2000" placeholder="e.g. Hi {{recipient.first_name}}, please review and sign {{document.title}}. Reply to this email with any questions.">${account.config.branding.email_message}</textarea></div>
            ${variablesHint()}
            <button type="submit">Save</button>
          </form>
          <form method="post" action="/settings/branding/font" class="card" aria-labelledby="contract-font">${csrfInput(csrf)}<header><h2 id="contract-font">Contract font</h2><p>The default font family for agreements, in the PDF and on the signing page. Each document can choose its own.</p></header>
            <fieldset><legend class="sr-only">Default font</legend><div class="row" style="gap:12px;margin-bottom:12px">${CONTRACT_FONT_NAMES.map((f) => html`<label class="font-choice ${CONTRACT_FONTS[f].css}"><input type="radio" name="font" value="${f}" ${account.config.branding.contract_font === f ? "checked" : ""}> <span class="font-sample">Aa</span> ${CONTRACT_FONTS[f].label}</label>`)}</div></fieldset>
            <button type="submit">Save</button>
          </form>
        </div>
        <section class="card branding-preview" aria-labelledby="preview"><header><h2 id="preview">Preview</h2><p>The email a signer receives. Save a change to see it here.</p></header>
          <iframe class="email-frame" src="/settings/branding/preview" title="Email preview"></iframe></section>
      </div>`);
  });

  app.get("/settings/branding/preview", async (c) => {
    requirePermission(c.get("user"), "settings.manage");
    const account = await getAccount(ctx);
    const logo = await readLogo(ctx);
    const { html: body } = renderEmail({
      account: account.name,
      branding: ctx.config.branding,
      hasLogo: logo !== null,
      bannerColor: account.config.branding.banner_color,
      icon: "document",
      person: { name: account.name, avatar: await emailAvatar(ctx.config, account.config.branding.avatars, c.get("user").label, account.name), initials: initialsOf(account.name) },
      signers: [
        { name: "Jane Doe", avatar: await emailAvatar(ctx.config, account.config.branding.avatars, "jane@acme.example", "Jane Doe"), initials: "JD" },
        { name: "Sam Lee", avatar: await emailAvatar(ctx.config, account.config.branding.avatars, "sam@automaze.example", "Sam Lee"), initials: "SL" },
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
    // Inline images (the account logo, the Signed.md footer logo) as data URLs, like the Outbox does.
    let shown = body;
    for (const a of [...(logo ? [{ cid: "logo@signed.md", contentType: logo.contentType, content: logo.data }] : []), ...brandAttachment(ctx)]) {
      shown = shown.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString("base64")}`);
    }
    return emailPage(c, shown, avatarOrigin(ctx.config));
  });

  app.post("/settings/branding/logo", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    const file = b.logo;
    try {
      if (!(file instanceof File)) throw new SignedError("INVALID_REQUEST", "Choose a logo file to upload");
      await setLogo(ctx, c.get("user"), new Uint8Array(await file.arrayBuffer()));
      return c.redirect("/settings/branding?msg=logo");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/settings/branding">Back</a>`);
    }
  });
  app.post("/settings/branding/look", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setBannerAndAvatars(ctx, c.get("user"), { banner_color: str(b, "banner_color"), avatars: str(b, "avatars") === "on" });
      return c.redirect("/settings/branding?msg=saved");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/settings/branding">Back</a>`);
    }
  });
  app.post("/settings/branding/font", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setContractFont(ctx, c.get("user"), str(b, "font"));
      return c.redirect("/settings/branding?msg=saved");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/settings/branding">Back</a>`);
    }
  });
  app.post("/settings/branding/logo/remove", async (c) => {
    await removeLogo(ctx, c.get("user"));
    return c.redirect("/settings/branding?msg=nologo");
  });
  app.post("/settings/branding/message", async (c) => {
    const b = (await c.req.parseBody()) as FormBody;
    try {
      await setDefaultMessage(ctx, c.get("user"), str(b, "message"));
      return c.redirect("/settings/branding?msg=saved");
    } catch (e) {
      if (!(e instanceof SignedError)) throw e;
      return page(c, "Branding", "settings", html`${alert("bad", html`${e.message}`)}<a class="button outline" href="/settings/branding">Back</a>`);
    }
  });

  // Hosted: email always goes out over SMTP, so there is no Outbox.
  if (ctx.config.hosted) app.use("/outbox/*", async (c) => c.notFound()).use("/outbox", async (c) => c.notFound());

  app.get("/outbox/:id/html", async (c) => {
    requirePermission(c.get("user"), "settings.manage");
    const m = await ctx.mailer.outboxEntry(c.req.param("id"));
    if (!m) return c.notFound();
    return emailPage(c, m.html, avatarOrigin(ctx.config));
  });

  // ---- Outbox ----

  app.get("/outbox", async (c) => {
    requirePermission(c.get("user"), "settings.manage");
    const smtp = ctx.mailer.smtp;
    const mails = await ctx.mailer.outbox(50);
    return page(c, "Outbox", "outbox", html`<div class="page-head"><h1>Outbox</h1></div>
      ${alert(smtp ? "info" : "warn", smtp ? `SMTP is configured (${smtp.host}). New emails are sent there. This list shows emails written before SMTP was set.` : "No SMTP server is set. Emails are kept here instead of being sent, so you can test the full flow. Set the SMTP_* environment variables to send them.")}
      ${mails.length === 0 ? html`<div class="card">No emails yet.</div>` : mails.map((m, i) => html`<details class="outbox-mail" ${i === 0 ? "open" : ""}><summary><strong>${m.subject}</strong> <span class="muted">→ ${m.to} · ${when(m.created_at)}</span></summary>
        ${m.html ? html`<iframe class="email-frame" src="/outbox/${m.id}/html" title="${m.subject}" loading="lazy"></iframe>` : ""}
        ${m.attachments.length ? html`<p class="small muted">Attachments: ${m.attachments.map((a) => `${a.filename} (${Math.round(a.size / 1024)} KB)`).join(", ")}</p>` : ""}
        <details class="small"><summary>Plain text version</summary><pre>${m.text}</pre></details></details>`)}`);
  });

  return app;
}

// ---------------------------------------------------------------------------

/** Avatar: initials, with the picture on top when there is one (app.js drops a picture that fails). */
function avatar(ctx: Ctx, enabled: boolean, name: string, email: string, size: "small" | "" = "", tooltip?: string): H {
  return avatarFigure(name, avatarUrl(ctx.config, enabled, email, name), size, tooltip);
}

/** "Name (email)" for a signer's tooltip. A draft may not have them yet, so fall back to the signer's key. */
function signerLabel(s: { key: string; name: string; email: string }): string {
  if (s.name && s.email) return `${s.name} (${s.email})`;
  return s.name || s.email || `${s.key} (not filled in yet)`;
}

function variablesHint(): H {
  return html`<p class="small muted" id="variables-hint" style="margin:6px 0 0">Placeholders, filled in for each signer: ${MESSAGE_VARIABLES.map((v, i) => html`${i ? ", " : ""}<code>{{${v}}}</code>`)}.</p>`;
}

/** Sub-navigation between pages, as links (no JavaScript). Looks like tabs; the current page is marked. */
function tabs(label: string, items: [string, string, boolean][]): H {
  return html`<nav class="page-tabs" aria-label="${label}">${items.map(([text, href, on]) => html`<a href="${href}" ${on ? html`aria-current="page"` : ""}>${text}</a>`)}</nav>`;
}

function settingsTabs(active: "general" | "branding"): H {
  return tabs("Settings sections", [["General", "/settings", active === "general"], ["Branding", "/settings/branding", active === "branding"]]);
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
  return authPage("Set up", html`
    <h1>Set up Signed.md</h1><p class="muted">Create the administrator account. You can change everything later.</p>
    ${error ? html`${alert("bad", html`${error}`)}` : ""}
    <form method="post" class="card">
      <div data-field><label for="f-account">Company name</label><input id="f-account" type="text" name="account" value="${b ? str(b, "account") : ""}" required></div>
      <div data-field><label for="f-name">Your name</label><input id="f-name" type="text" name="name" value="${b ? str(b, "name") : ""}" required autocomplete="name"></div>
      <div data-field><label for="f-email">Your email</label><input id="f-email" type="email" name="email" value="${b ? str(b, "email") : ""}" required autocomplete="username"></div>
      <div data-field><label for="f-password">Password <span class="muted">· at least 10 characters</span></label><input id="f-password" type="password" name="password" required minlength="10" autocomplete="new-password"></div>
      <button type="submit" class="w-full">Create account</button>
    </form>`);
}

function invitePage(inv: { email: string; role: string; account_name: string; inviter: string | null }, error: string | null, name = "", hosted = false): H {
  return authPage("Join", html`
    <h1>Join ${inv.account_name}</h1>
    <p class="muted">${inv.inviter ?? "Someone"} invited you to Signed.md as ${ROLE_LABELS[inv.role as keyof typeof ROLE_LABELS].toLowerCase()}.</p>
    ${error ? html`${alert("bad", html`${error}`)}` : ""}
    <form method="post" class="card">
      <div data-field><label for="f-email">Email</label><input id="f-email" type="email" value="${inv.email}" disabled></div>
      <div data-field><label for="f-name">Your name</label><input id="f-name" type="text" name="name" value="${name}" required autocomplete="name"></div>
      ${hosted
        ? html`<p class="small muted">Next time, sign in with the Google or Microsoft account for ${inv.email}.</p>`
        : html`<div data-field><label for="f-password">Choose a password <span class="muted">· at least 10 characters</span></label><input id="f-password" type="password" name="password" required minlength="10" autocomplete="new-password"></div>`}
      <button type="submit" class="w-full">Join ${inv.account_name}</button>
    </form>`);
}

const GOOGLE_LOGO = raw('<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.7 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>');
const MICROSOFT_LOGO = raw('<svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>');

/** Email login (unless hosted) and the optional Google and Microsoft buttons. */
function loginPage(error: string | undefined, email: string | undefined, buttons: { google: string | null; microsoft: string | null }, passwords: boolean): H {
  const any = buttons.google || buttons.microsoft;
  return authPage("Log in", html`
    ${error ? html`${alert("bad", html`${error}`)}` : ""}
    ${any
      ? html`<div class="card" style="display:grid;gap:10px">
      ${buttons.google ? html`<a class="button outline w-full" href="${buttons.google}">${GOOGLE_LOGO} Continue with Google</a>` : ""}
      ${buttons.microsoft ? html`<a class="button outline w-full" href="${buttons.microsoft}">${MICROSOFT_LOGO} Continue with Microsoft</a>` : ""}
    </div>`
      : ""}
    ${passwords
      ? html`<form method="post" class="card">
      <div data-field><label for="f-email">Email</label><input id="f-email" type="email" name="email" value="${email ?? ""}" required autocomplete="username"></div>
      <div data-field><label for="f-password">Password</label><input id="f-password" type="password" name="password" required autocomplete="current-password"></div>
      <button type="submit" class="w-full">Log in</button>
      <p class="small forgot"><a href="/forgot">Forgot your password?</a></p>
    </form>`
      : ""}`);
}

/** Public pages (log in, set up, join, password reset): a narrow column. The footer carries our logo. */
function authPage(title: string, body: H): H {
  return shell({ title }, html`<div class="narrow auth">${body}</div>`);
}

function forgotPage(email = "", sent = false, canEmail = true): H {
  return authPage("Forgot password", html`<h1>Forgot your password?</h1>
    ${!canEmail
      ? html`<p class="muted">This server can't send email yet, so it can't send you a reset link. Ask the person who runs Signed.md for your organisation to reset your password.</p>
        <a class="button outline" href="/login">Back to log in</a>`
      : sent
      ? html`${alert("ok", html`If <strong>${email}</strong> has an account here, we've sent it a link to choose a new password. The link expires in ${RESET_MINUTES} minutes.`)}
        <p class="small muted">No email? Check your spam folder, or <a href="/forgot">ask again</a> in a minute.</p>
        <a class="button outline" href="/login">Back to log in</a>`
      : html`<p class="muted">Enter the email you log in with. We'll send you a link to choose a new password.</p>
        <form method="post" class="card">
          <div data-field><label for="f-email">Email</label><input id="f-email" type="email" name="email" value="${email}" required autocomplete="username" autofocus></div>
          <button type="submit" class="w-full">Send reset link</button>
          <p class="small forgot"><a href="/login">Back to log in</a></p>
        </form>`}`);
}

function resetPage(email: string, error?: string): H {
  return authPage("Choose a new password", html`<h1>Choose a new password</h1>
    ${error ? alert("bad", error) : ""}
    <form method="post" class="card">
      <input type="email" name="username" value="${email}" autocomplete="username" hidden>
      <div data-field><label for="f-email">Email</label><input id="f-email" type="email" value="${email}" disabled></div>
      <div data-field><label for="f-password">New password <span class="muted">· at least 10 characters</span></label><input id="f-password" type="password" name="password" required minlength="10" autocomplete="new-password" autofocus></div>
      <button type="submit" class="w-full">Save password and log in</button>
    </form>`);
}

function resetInvalidPage(): H {
  return authPage("Link expired", html`<div class="card"><h1>This link has expired</h1>
    <p class="muted">Password reset links work once and expire after ${RESET_MINUTES} minutes. Ask for a new one.</p>
    <a class="button" href="/forgot">Send a new link</a></div>`);
}

function inlineStart(csrf: string, font: ContractFont, content = "# Agreement\n\nThis agreement is between {{$party_a:text}} and {{$party_b:text}}.\n\nSigned: {{client.signature:signature}}\n", folder?: string): H {
  return html`<div class="page-head"><h1>New inline document</h1></div>
    <form method="post" action="${withQuery("/documents/new/inline", { folder })}" class="card">${csrfInput(csrf)}${markdownEditor("content", content, font)}
      <p class="small muted">Use <code>{{$name:type}}</code> for values you fill in now and <code>{{signer.field:type}}</code> for what signers fill in.</p>
      <button type="submit">Continue</button></form>`;
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
  font?: string;
  /** Font for the preview. */
  previewFont?: ContractFont;
  /** Source shown read-only as pages beside the form (templates, and inline drafts not being edited). */
  preview?: string;
  /** Document folders, for new drafts. */
  folders?: folders.FolderView[];
  folderId?: string | null;
}

function documentForm(csrf: string, s: DocFormState): H {
  const valueFields = s.fields.filter((f) => f.kind === "value");
  const font = s.previewFont ?? "serif";
  // The main area: the Markdown editor with its preview (inline drafts being edited), or the pages.
  const main =
    s.mode === "inline" && s.editId
      ? markdownEditor("content", s.content ?? "", font)
      : html`${s.mode === "inline" ? html`<input type="hidden" name="content" value="${s.content ?? ""}">` : ""}${s.preview !== undefined ? html`<section class="editor-preview doc-form-preview zoomable" aria-label="Preview">${markdownPreview(s.preview, font)}${zoomControls()}</section>` : ""}`;
  return html`<div class="page-head"><h1>${s.editId ? "Edit draft" : "New document"}</h1>${s.templateName ? html`<span class="muted">From ${s.templateName} v${s.version}</span>` : ""}</div>
    <form method="post" action="${s.editId ? `/documents/${s.editId}/edit` : "/documents"}" class="doc-form">${csrfInput(csrf)}
      ${s.templateId ? html`<input type="hidden" name="template_id" value="${s.templateId}">` : ""}
      <div class="grid">
        <div>${main}</div>
        <aside>
          <section class="card" aria-labelledby="draft-details"><header><h2 id="draft-details">Details</h2></header>
            <div data-field><label for="f-title">Title <span class="muted">· optional</span></label><input id="f-title" type="text" name="title" value="${s.title ?? ""}"></div>
            <div class="inline-fields">
              <div data-field><label for="f-expires_in_days">Expires after (days)</label><input id="f-expires_in_days" type="number" min="1" max="365" name="expires_in_days" value="${s.expires ?? ""}" placeholder="default"></div>
              <div data-field><label for="f-font">Font</label><select id="f-font" name="font">
                <option value="" ${!s.font ? "selected" : ""}>Account default</option>
                ${CONTRACT_FONT_NAMES.map((f) => html`<option value="${f}" ${s.font === f ? "selected" : ""}>${CONTRACT_FONTS[f].label}</option>`)}
              </select></div>
            </div>
            ${!s.editId && s.folders?.length ? html`<div data-field><label for="f-folder">Folder</label>${folderSelect("f-folder", s.folders, s.folderId)}</div>` : ""}
          </section>
          ${valueFields.length ? html`<section class="card" aria-labelledby="values"><header><h2 id="values">Values</h2></header>${valueFields.map((f) => valueInput(f, s.values[f.name!]))}</section>` : ""}
          <section class="card" aria-labelledby="draft-signers"><header><h2 id="draft-signers">Signers</h2></header>${signerRows(s.signers, s.mode === "template")}${s.mode === "inline" ? html`<button type="button" class="outline small" id="add-signer" style="margin-top:8px">Add signer</button>` : ""}</section>
          <div><button type="submit">${s.editId ? "Save draft" : "Create draft"}</button> <p class="small muted" style="margin:8px 0 0">You'll preview it before sending.</p></div>
        </aside>
      </div>
    </form>`;
}

function templateForm(csrf: string, font: ContractFont, s: { id?: string; name: string; description: string; source: string; folders?: folders.FolderView[]; folderId?: string | null }, canApprove: boolean, offerImport = false, notice?: H): H {
  // Like editing a document's text: the editor on the left, the live preview on the right.
  return html`<script src="${asset("vendor/overtype.js")}" defer></script>
    <div class="workspace editing editor-scope">
      <section class="edit-pane" aria-label="Template">
        <header class="doc-head">
          <div class="title-block">
            ${s.id
              ? html`<h1>${s.name}</h1>`
              : html`<label for="f-name" class="sr-only">Template name</label>
                <input id="f-name" class="title-input" type="text" name="name" form="template-form" value="${s.name}" placeholder="New template" required autocomplete="off">`}
            ${s.id ? html`<div class="row small muted">New version</div>` : s.folders?.length ? html`<div class="row small muted"><label for="f-folder">Folder</label>${folderSelect("f-folder", s.folders, s.folderId, "template-form")}</div>` : ""}
          </div>
          ${offerImport ? importForm(csrf, "/templates/import", "Start from a Word or PDF file") : ""}
          <button type="button" class="ghost small help-button help-top" popovertarget="placeholder-help" aria-controls="placeholder-help">Placeholder help</button>
        </header>
        ${notice ?? ""}
        <form method="post" action="${s.id ? `/templates/${s.id}/edit` : "/templates"}" class="text-form" id="template-form">${csrfInput(csrf)}
          <div class="meta-fields single">
            <div data-field><label for="f-description" class="sr-only">Description</label><input id="f-description" type="text" name="description" value="${s.description}" placeholder="Description (optional): what it's for, who signs"></div>
          </div>
          <label for="f-source" class="sr-only">Markdown</label>
          <textarea id="f-source" class="code" name="source" autocapitalize="none" autocorrect="off" spellcheck="false" data-preview-source data-font="${font}" data-ot-padding="24px">${s.source}</textarea>
          <footer class="edit-bar">
            ${canApprove
              ? html`<button type="submit" name="approve" value="1" class="main-action">Save and approve</button><button type="submit" class="outline" name="approve" value="0">Save as pending</button>`
              : html`<button type="submit" name="approve" value="0" class="main-action">Save for approval</button><span class="small muted">An owner approves templates before anyone can use them.</span>`}
            <button type="button" class="ghost small help-button" popovertarget="placeholder-help" aria-controls="placeholder-help">Placeholder help</button>
          </footer>
        </form>
      </section>
      <section class="preview-pane zoomable" aria-label="Preview"><div data-preview-target aria-live="polite">${markdownPreview(s.source, font)}</div>${zoomControls()}</section>
    </div>
    <aside id="placeholder-help" class="drawer" popover="manual" aria-labelledby="placeholder-help-title">
      <header><h2 id="placeholder-help-title">Placeholders</h2><button type="button" class="ghost icon" popovertarget="placeholder-help" popovertargetaction="hide" aria-label="Close">${icon("close")}</button></header>
      <div class="small">
          <p><code>{{$name:type}}</code> – a value filled in when the document is created (by you or an agent).<br>
          <code>{{signer.field:type}}</code> – filled in by that signer while signing, e.g. <code>{{client.signature:signature}}</code>.</p>
          <p>Types: <code>text</code>, <code>longtext</code>, <code>number</code>, <code>currency(USD)</code>, <code>date</code>, <code>signature</code>, <code>initials</code>, <code>checkbox</code>, <code>choice(a|b)</code>.</p>
          <p>Columns put blocks side by side, for example signature blocks: <code>&lt;!-- columns --&gt;</code>, then <code>&lt;!-- column --&gt;</code> between columns, then <code>&lt;!-- /columns --&gt;</code>, each on its own line. At most 3 columns.</p>
          <p>Optional front matter adds rules: <code>label</code>, <code>required</code>, <code>default</code>, <code>minimum</code>, <code>maximum</code>, <code>max_length</code>, <code>allowed_values</code>, <code>options</code>. Write <code>\\{{</code> for literal braces.</p></div>
    </aside>`;
}

function isContractFont(name: string): name is ContractFont {
  return (CONTRACT_FONT_NAMES as readonly string[]).includes(name);
}

/** Render Markdown the way the template page shows it: values and signer fields as labelled chips. */
function previewArticle(body: string, fields: FieldDef[], font: ContractFont): H {
  return html`<div class="pages" data-paginate role="group" aria-label="Document preview"><article class="doc page ${CONTRACT_FONTS[font].css}"><div class="page-body">${raw(renderHtml(body, {
    fields,
    valueSlots: true,
    renderField: (f) => ({
      type: "element",
      tagName: "span",
      properties: { className: ["smd-field", f.kind === "value" ? "smd-field-value" : "smd-field-signer"] },
      children: [{ type: "text", value: f.kind === "value" ? `${f.rules.label ?? f.name}` : `${f.rules.label ?? f.key.split(".")[1]!.replace(/_/g, " ")} – ${f.signer}` }],
    }),
  }))}</div></article></div>`;
}

/** Problems in the source, then the rendered preview. Also the response of POST /preview. */
function markdownPreview(source: string, font: ContractFont): H {
  const parsed = parseTemplate(source);
  return html`${parsed.issues.length ? html`${alert("bad", html`Fix before saving:${issuesList(parsed.issues)}`)}` : ""}${previewArticle(parsed.body, parsed.fields, font)}`;
}

/**
 * A Markdown editor with a live preview beside it (stacked on narrow screens). Without JavaScript
 * it is a plain textarea. app.js swaps in OverType, which keeps a real textarea with the same name
 * and id, so the form, the label and the preview all keep working.
 */
function markdownEditor(name: string, value: string, font: ContractFont): H {
  return html`<script src="${asset("vendor/overtype.js")}" defer></script>
  <div class="editor">
    <div data-field><label for="f-${name}">Markdown</label><textarea id="f-${name}" class="code" name="${name}" autocapitalize="none" autocorrect="off" data-preview-source data-font="${font}" spellcheck="false">${value}</textarea></div>
    <section class="editor-preview zoomable" aria-label="Preview"><div data-preview-target aria-live="polite">${markdownPreview(value, font)}</div>${zoomControls()}</section>
  </div>`;
}

/**
 * For agents: the template's ID and an example prompt that uses its values and signers, both
 * click to copy. Agents create documents from a template by its ID.
 */
function agentStrip(t: { id: string; name: string; approved_version: number | null }, fields: FieldDef[]): H {
  const values = fields.filter((f) => f.kind === "value").map((f) => `${f.name} = …`);
  const signers = [...new Set(fields.filter((f) => f.kind === "signer").map((f) => f.signer!))].map((k) => `${k} (name, email)`);
  const prompt = [
    `Use Signed.md to create a document from the template "${t.name}" (${t.id}).`,
    values.length ? `Fill in ${values.join(", ")}.` : "",
    signers.length ? `The signers are ${signers.join(" and ")}.` : "",
    "Show me the preview, and send it only after I approve.",
  ].filter(Boolean).join(" ");
  return html`<section class="agent-strip" aria-labelledby="for-agents"><h3 class="panel-sub" id="for-agents">For agents</h3>
    <dl class="kv small"><dt>Template ID</dt><dd>${copyValue(t.id)}</dd></dl>
    ${t.approved_version ? "" : html`<p class="tiny muted" style="margin:0 0 8px">Agents can use it once a version is approved.</p>`}
    <p class="tiny muted" style="margin:8px 0 4px">Example prompt · click to copy</p>
    <button type="button" class="copy-value block prompt" data-copy="${prompt}" data-copy-flash title="Click to copy">${prompt}</button>
  </section>`;
}

/**
 * A template's placeholders for the side panel: values (filled when a document is created), then
 * each signer's fields, with their type and rules in plain words.
 */
function fieldsPanel(fields: FieldDef[]): H {
  if (!fields.length) return html`<p class="small muted">No placeholders.</p>`;
  const type = (f: FieldDef) => (f.type === "choice" ? "choice" : `${f.type}${f.param ? `(${f.param})` : ""}`);
  const rules = (f: FieldDef): string => {
    const r = f.rules;
    const out: string[] = [];
    const options = r.options ?? (f.type === "choice" && f.param ? f.param.split("|") : undefined);
    if (options) out.push(`one of ${options.join(", ")}`);
    if (r.allowed_values) out.push(`one of ${r.allowed_values.join(", ")}`);
    if (r.minimum !== undefined) out.push(`at least ${r.minimum}`);
    if (r.maximum !== undefined) out.push(`at most ${r.maximum}`);
    if (r.max_length !== undefined) out.push(`up to ${r.max_length} characters`);
    if (r.default !== undefined) out.push(`default ${String(r.default)}`);
    if (r.required === false) out.push("optional");
    return out.join(" · ");
  };
  const item = (f: FieldDef, name: string) => html`<li><span class="field-name">${f.rules.label ?? name}</span><span class="field-type">${type(f)}</span>
    ${f.rules.label ? html`<span class="field-key">${f.key}</span>` : ""}${rules(f) ? html`<span class="field-rules">${rules(f)}</span>` : ""}</li>`;
  const values = fields.filter((f) => f.kind === "value");
  const signers = [...new Set(fields.filter((f) => f.kind === "signer").map((f) => f.signer!))];
  return html`${values.length ? html`<h3 class="panel-sub">Values <span class="muted">· filled in when a document is created</span></h3><ul class="field-list">${values.map((f) => item(f, f.name ?? f.key))}</ul>` : ""}
    ${signers.map((sk) => html`<h3 class="panel-sub">Signer <code>${sk}</code> <span class="muted">· fills in while signing</span></h3><ul class="field-list">${fields.filter((f) => f.kind === "signer" && f.signer === sk).map((f) => item(f, f.key.split(".")[1]!.replace(/_/g, " ")))}</ul>`)}`;
}

/**
 * The prompt that sets up any agent: where the skill is, which Signed.md server to use, and the
 * ground rules. Only the server's address changes between setups.
 */
function agentSetupPrompt(serverUrl: string, hosted: boolean): string {
  return [
    `Set up Signed.md for me using the official skill at ${serverUrl}/skill.md.`,
    `My Signed.md server is ${serverUrl}.`,
    `Help me connect securely: I'll create an API key on the Agents page and give it to you, and you keep it out of your replies.`,
    `Once connected, check that you can reach my account and tell me what you can do.`,
    `Don't send any documents${hosted ? " or change my plan" : ""} without my approval.`,
  ].join("\n");
}

/** A value people copy (endpoints, commands): click it to copy. `block` shows it as a code block. */
function copyValue(value: string, block = false, prose = false): H {
  return html`<button type="button" class="copy-value${block ? " block" : ""}${prose ? " prompt" : ""}" data-copy="${value}" data-copy-flash title="Click to copy">${value}</button>`;
}

/** Zoom out and in on the pages (the PDF side). app.js does the work and remembers the level. */
function zoomControls(): H {
  return html`<div class="zoom-controls" role="group" aria-label="Zoom"><button type="button" class="ghost icon" data-zoom="-1" aria-label="Zoom out">${icon("minus")}</button><output aria-live="polite">100%</output><button type="button" class="ghost icon" data-zoom="1" aria-label="Zoom in">${icon("plus")}</button></div>`;
}

/** A URL with query parameters, leaving out empty ones. */
/** Newer and older pages of a list, keeping the current filters. Nothing when the list fits on one page. */
function pager(url: string, what: string, newer: string | null, older: string | null): H | string {
  if (!newer && !older) return "";
  const link = (key: "before" | "after", cursor: string) => {
    const u = new URL(url);
    for (const k of ["before", "after", "msg"]) u.searchParams.delete(k);
    u.searchParams.set(key, cursor);
    return u.pathname + u.search;
  };
  return html`<nav class="pager" aria-label="More ${what}">
    ${newer ? html`<a class="button outline small" href="${link("after", newer)}" rel="prev">${icon("chevronLeft")} Newer</a>` : html`<span></span>`}
    ${older ? html`<a class="button outline small" href="${link("before", older)}" rel="next">Older ${icon("chevronRight")}</a>` : ""}
  </nav>`;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  return q.size ? `${path}?${q}` : path;
}

/** The page title. Inside a folder: a breadcrumb back to the top level, and the folder's name. */
function folderHead(title: string, path: string, current: folders.FolderView | undefined, actions: H | string): H {
  return current
    ? html`<nav aria-label="Breadcrumb" class="crumbs"><ol><li><a href="${path}">${title}</a></li><li><a href="${path}?folder=${current.id}" aria-current="page">${current.name}</a></li></ol></nav>
      <div class="page-head"><div class="row-stretch"><h1>${icon("folder")} ${current.name}</h1>${actions}</div></div>`
    : html`<div class="page-head"><div class="row-stretch"><h1>${title}</h1>${actions}</div></div>`;
}

/**
 * Folder cards above the top-level list. Each card links to its folder. People who can manage
 * folders get, on each card (shown on hover or focus), rename in place and delete, which asks
 * first. Deleting moves what is in the folder to the top level. New folders come from newMenu.
 */
function folderGrid(kind: folders.FolderKind, all: folders.FolderView[], counts: Map<string, number>, href: (id: string) => string, manage: boolean, csrf: string): H {
  if (!all.length) return html``;
  const noun = kind === "template" ? "template" : "document";
  const many = (n: number) => (n === 0 ? "Empty" : `${n} ${noun}${n === 1 ? "" : "s"}`);
  return html`<section class="folders" aria-labelledby="${kind}-folders-title">
    <header class="section-head"><h2 id="${kind}-folders-title">Folders <span class="muted">${all.length}</span></h2></header>
    ${all.length
      ? html`<ul class="folder-grid">${all.map((f) => html`<li><article class="folder-card" aria-labelledby="fld-${f.id}">
          ${icon("folder")}
          <hgroup><h3 id="fld-${f.id}" class="small"><a class="card-link" href="${href(f.id)}">${f.name}</a></h3><p class="tiny">${many(counts.get(f.id) ?? 0)}</p></hgroup>
          ${manage
            ? html`<form method="post" action="/folders/${f.id}/rename" class="folder-rename" hidden>${csrfInput(csrf)}<input type="hidden" name="kind" value="${kind}">
                <label for="rename-${f.id}" class="sr-only">New name for ${f.name}</label><input type="text" id="rename-${f.id}" name="name" value="${f.name}" required maxlength="80" autocomplete="off">
                <button type="submit" class="small icon" aria-label="Save" title="Save">${icon("check")}</button><button type="button" class="ghost small icon" data-rename-cancel aria-label="Cancel" title="Cancel">${icon("close")}</button></form>
              <footer class="folder-actions">
                <button type="button" class="ghost small icon" data-rename aria-label="Rename ${f.name}" title="Rename">${icon("pencil")}</button>
                <button type="button" class="ghost small icon" commandfor="delete-${f.id}" command="show-modal" aria-label="Delete ${f.name}" title="Delete">${icon("trash")}</button>
              </footer>
              <dialog id="delete-${f.id}" closedby="any" aria-labelledby="delete-${f.id}-title" aria-describedby="delete-${f.id}-text">
                <form method="post" action="/folders/${f.id}/delete">${csrfInput(csrf)}<input type="hidden" name="kind" value="${kind}">
                  <header><h2 id="delete-${f.id}-title">Delete the folder “${f.name}”?</h2></header>
                  <p id="delete-${f.id}-text">${(counts.get(f.id) ?? 0) === 0 ? html`It is empty.` : counts.get(f.id) === 1 ? html`The ${noun} in it won't be deleted. It moves to the top level.` : html`The ${counts.get(f.id)} ${noun}s in it won't be deleted. They move to the top level.`}</p>
                  <footer><button type="button" class="outline" commandfor="delete-${f.id}" command="close">Cancel</button><button type="submit" data-variant="danger">Delete folder</button></footer>
                </form>
              </dialog>`
            : ""}
        </article></li>`)}</ul>`
      : ""}
  </section>`;
}

/**
 * The "New" button on the Documents and Templates lists. The main part makes a document or
 * template; the chevron opens a menu that also offers a folder (only at the top level, since
 * folders are one level deep). Without the folder choice it is a plain button.
 */
function newMenu(kind: folders.FolderKind, href: string, folder: boolean, csrf: string): H {
  const noun = kind === "template" ? "template" : "document";
  if (!folder) return html`<a class="button" href="${href}">New ${noun}</a>`;
  return html`<div class="split-button" role="group" aria-label="New">
      <a class="button" href="${href}" aria-label="New ${noun}">New</a>
      <ot-dropdown>
        <button type="button" id="new-trigger" popovertarget="new-menu" aria-haspopup="menu" aria-label="More things to create">${icon("chevronDown")}</button>
        <div popover id="new-menu" class="new-menu" role="menu" aria-labelledby="new-trigger">
          <a role="menuitem" href="${href}">${icon(kind === "template" ? "template" : "file")} ${kind === "template" ? "Template" : "Document"}</a>
          <button type="button" role="menuitem" class="ghost" commandfor="new-folder" command="show-modal">${icon("folder")} Folder</button>
        </div>
      </ot-dropdown>
    </div>
    <dialog id="new-folder" closedby="any" aria-labelledby="new-folder-title">
      <form method="post" action="/folders">${csrfInput(csrf)}<input type="hidden" name="kind" value="${kind}">
        <header><h2 id="new-folder-title">New ${noun} folder</h2></header>
        ${field("new-folder-name", "Name", html`<input type="text" id="new-folder-name" name="name" required maxlength="80" autocomplete="off" autofocus>`)}
        <footer><button type="button" class="outline" commandfor="new-folder" command="close">Cancel</button><button type="submit">Create folder</button></footer>
      </form>
    </dialog>`;
}

/** What each role can do, for the Team page's explanation and the change-role dialog. */
const ROLE_HELP: Record<keyof typeof ROLE_LABELS, string> = {
  owner: "Everything, including approving templates and inline documents.",
  admin: "Manages the team and settings. Sees and acts on every document. Can't approve templates.",
  member: "Creates and sends documents, and sees only their own. Can draft templates for approval.",
  viewer: "Read-only access to all documents, templates, and activity.",
};

/** Change someone's role: pick one, then confirm. */
function roleDialog(m: { id: string; name: string; role: keyof typeof ROLE_LABELS }, roles: (keyof typeof ROLE_LABELS)[], csrf: string): H {
  return html`<dialog id="role-${m.id}" closedby="any" aria-labelledby="role-${m.id}-title">
    <form method="post" action="/team/${m.id}/role">${csrfInput(csrf)}
      <header><h2 id="role-${m.id}-title">Change ${m.name}'s role</h2></header>
      <div><fieldset class="role-choices"><legend class="sr-only">Role</legend>
        ${roles.map((r) => html`<label><input type="radio" name="role" value="${r}" ${r === m.role ? "checked" : ""} required><span><strong>${roleIcon(r)}${ROLE_LABELS[r]}</strong><span class="tiny muted">${ROLE_HELP[r]}</span></span></label>`)}
      </fieldset>
      <p class="small muted" style="margin:0">The change applies at once, including to their API keys.</p></div>
      <footer><button type="button" class="outline" commandfor="role-${m.id}" command="close">Cancel</button><button type="submit">Change role</button></footer>
    </form>
  </dialog>`;
}

/** A tiny icon for a role in the team list: a crown for owners. */
function roleIcon(role: keyof typeof ROLE_LABELS): H {
  return html`<span class="role-icon" data-role="${role}" aria-hidden="true">${icon(role === "owner" ? "crown" : role === "admin" ? "shield" : role === "viewer" ? "eye" : "user")}</span>`;
}

/** This page's path and query, without the given parameters (to come back here after a form). */
function hereWithout(url: string, ...drop: string[]): string {
  const u = new URL(url);
  for (const d of drop) u.searchParams.delete(d);
  return u.pathname + u.search;
}

/** A form's "back" field, if it is a path on this site (never another host). */
function localBack(back: string): string | null {
  return /^\/(?![\/\\])/.test(back) ? back : null;
}

/**
 * The Folder cell in the Documents and Templates lists: the folder's name, or a dash. People who
 * can move the item get a menu of all folders; picking one moves it there and comes back.
 */
function folderCell(kind: folders.FolderKind, item: { id: string; folder: { id: string; name: string } | null }, all: folders.FolderView[], canMove: boolean, csrf: string, back: string): H {
  const label = item.folder ? item.folder.name : "–";
  const spoken = item.folder ? item.folder.name : "None";
  if (!canMove || !all.length) return html`<span class="${item.folder ? "" : "muted"}" ${item.folder ? "" : html`aria-label="None"`}>${label}</span>`;
  const base = kind === "template" ? "/templates" : "/documents";
  const choice = (id: string, name: string) => {
    const here = (item.folder?.id ?? "") === id;
    return html`<button type="submit" role="menuitem" class="ghost" name="folder_id" value="${id}" ${here ? html`aria-current="true"` : ""}>${id ? icon("folder") : icon("dot")}<span>${name}</span>${here ? icon("check") : ""}</button>`;
  };
  return html`<ot-dropdown class="folder-move">
      <button type="button" class="link-button${item.folder ? "" : " muted"}" id="move-${item.id}-trigger" popovertarget="move-${item.id}" aria-haspopup="menu" aria-label="Folder: ${spoken}. Move to another folder">${label}${icon("chevronDown")}</button>
      <div popover id="move-${item.id}" class="move-menu" role="menu" aria-labelledby="move-${item.id}-trigger">
        <form method="post" action="${base}/${item.id}/move" role="none">${csrfInput(csrf)}<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="back" value="${back}">
          ${choice("", "No folder")}${all.map((f) => choice(f.id, f.name))}
        </form>
      </div>
    </ot-dropdown>`;
}

/** Choose a folder: a select with "No folder" first. */
function folderSelect(id: string, all: folders.FolderView[], current: string | null | undefined, form?: string): H {
  return html`<select id="${id}" name="folder_id" ${form ? html`form="${form}"` : ""}><option value="">No folder</option>${all.map((f) => html`<option value="${f.id}" ${f.id === current ? "selected" : ""}>${f.name}</option>`)}</select>`;
}

/** Upload an existing contract (Word, OpenDocument, RTF or PDF) to convert it to Markdown. */
function importForm(csrf: string, action: string, label: string): H {
  // The button is the file input's label: choosing a file uploads it at once (app.js). The input
  // stays in the tab order, visually hidden; without JavaScript a plain picker and button show.
  const id = `import-${action.replace(/\W+/g, "-")}`;
  return html`<form method="post" action="${action}" enctype="multipart/form-data" class="import-form" aria-label="${label}" data-auto-import>${csrfInput(csrf)}
    <input type="file" id="${id}" name="file" accept="${IMPORT_ACCEPT}" required aria-describedby="${id}-hint">
    <label for="${id}" class="button outline small import-label">Import (Word/PDF)</label>
    <noscript><button type="submit" class="outline small">Import</button></noscript>
    <small data-hint id="${id}-hint" class="sr-only">${label}: Word, OpenDocument, RTF or PDF, up to 3 MB. Converted on this server.</small>
  </form>`;
}

/** Shown when the plan's sending limit is reached (hosted service only). */
function limitAlert(hit: LimitHit): H {
  return html`${alert("bad", html`<strong>${hit.summary}</strong> New contracts can't be created or sent until you upgrade.<div style="margin-top:10px"><a class="button small" href="${hit.url}">Upgrade plan</a></div>`)}`;
}
