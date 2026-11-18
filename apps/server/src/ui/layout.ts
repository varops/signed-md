import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { HOSTED_APP_URL } from "../hosted.ts";
import { initialsOf } from "../services/avatars.ts";

export type H = HtmlEscapedString | Promise<HtmlEscapedString>;

let sourceUrl = "https://github.com/varops/signed-md";

/** Set once at startup from SOURCE_URL. */
export function setSourceUrl(url: string): void {
  sourceUrl = url;
}

let branding = true;

/** Set once at startup from BRANDING (hosted service only). */
export function setBranding(on: boolean): void {
  branding = on;
}

let hosted = false;

/** Set once at startup from HOSTED. Hosted installations have no Outbox. */
export function setHosted(on: boolean): void {
  hosted = on;
}

export const PRODUCT_URL = "https://signed.md";

/**
 * Footer with the source link that AGPL-3.0 section 13 asks network services to offer.
 * The source link stays even when branding is off.
 */
export function footer(): H {
  return branding
    ? html`<footer class="site-foot">Powered by <a href="${PRODUCT_URL}" rel="noopener">Signed.md</a> · open source under AGPL-3.0 · <a href="${sourceUrl}" rel="noopener">Source</a></footer>`
    : html`<footer class="site-foot">Open source under AGPL-3.0 · <a href="${sourceUrl}" rel="noopener">Source</a></footer>`;
}

export interface ShellOptions {
  title: string;
  user?: { email: string; name: string; role: "owner" | "admin" | "member" | "viewer"; theme?: "system" | "light" | "dark"; avatar?: string | null } | null;
  csrf?: string;
  active?: string;
  flash?: { kind: "ok" | "bad" | "warn" | "info"; text: string } | null;
}

type NavRole = "owner" | "admin" | "member" | "viewer";
const NAV: [string, string, string, NavRole[]][] = [
  ["documents", "/documents", "Documents", ["owner", "admin", "member", "viewer"]],
  ["templates", "/templates", "Templates", ["owner", "admin", "member", "viewer"]],
  ["team", "/team", "Team", ["owner", "admin"]],
  ["activity", "/activity", "Activity", ["owner", "admin", "viewer"]],
  ["settings", "/settings", "Settings", ["owner", "admin", "member", "viewer"]],
  ["outbox", "/outbox", "Outbox", ["owner", "admin"]],
];

export function shell(opts: ShellOptions, body: H): H {
  return html`<!doctype html>
<html lang="en" data-theme="${opts.user?.theme ?? "system"}" class="${opts.user?.theme === "dark" ? "dark" : ""}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Signed.md</title>
<script src="/assets/theme.js"></script>
<link rel="stylesheet" href="/assets/vendor/basecoat.css">
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="data:image/svg+xml,${raw(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1c1917"/><path d="M8 20c3-6 5-9 7-9s0 9 2 9 3-5 7-5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>'))}">
</head>
<body>
${opts.user
  ? html`<header class="topbar">
  <a class="brand" href="/documents">Signed<span>.md</span></a>
  <nav class="nav">${NAV.filter(([k, , , roles]) => roles.includes(opts.user!.role) && !(hosted && k === "outbox")).map(([k, href, label]) => html`<a href="${href}" class="${opts.active === k ? "active" : ""}">${label}</a>`)}</nav>
  ${hosted
    ? accountMenu(opts.user, opts.csrf ?? "")
    : html`<a class="whoami small" href="/settings" title="${opts.user.email}">${opts.user.name} <span class="muted">· ${opts.user.role === "admin" ? "administrator" : opts.user.role}</span></a>
  <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${opts.csrf ?? ""}"><button class="btn" data-variant="outline" data-size="sm">Log out</button></form>`}
</header>`
  : ""}
<main class="wrap">
${opts.flash ? alert(opts.flash.kind, opts.flash.text) : ""}
${body}
</main>
${footer()}
<script src="/assets/app.js" defer></script>
</body>
</html>`;
}

/** Hosted: the person's avatar and name, opening a menu with their account on app.signed.md and log out. */
function accountMenu(user: { email: string; name: string; avatar?: string | null }, csrf: string): H {
  const face = (size: "sm" | "md") =>
    html`<span class="avatar" ${size === "sm" ? html`data-size="sm"` : ""}><span>${initialsOf(user.name)}</span>${user.avatar ? html`<img src="${user.avatar}" alt="" referrerpolicy="no-referrer">` : ""}</span>`;
  return html`<details class="account-menu">
    <summary title="${user.email}">${face("sm")}<span class="account-name small">${user.name}</span></summary>
    <div class="account-pop" role="menu">
      <div class="account-head">${face("md")}<div><strong>${user.name}</strong><div class="small muted">${user.email}</div></div></div>
      <a role="menuitem" href="${HOSTED_APP_URL}/account">${icon("account")} Manage account</a>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button role="menuitem" type="submit">${icon("logout")} Log out</button></form>
    </div>
  </details>`;
}

/** Lucide icons (ISC licence), inline so no icon font or external request is needed. */
const ICONS = {
  ok: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bad: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  account: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
} as const;

export function icon(name: keyof typeof ICONS): H {
  return raw(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
}

/** Basecoat alert. "warn" is a default alert with an amber icon. */
export function alert(kind: "ok" | "info" | "warn" | "bad", content: H | string): H {
  const variant = kind === "bad" ? html` data-variant="destructive"` : kind === "warn" ? html` data-tone="warn"` : "";
  return html`<div class="alert"${variant}>${icon(kind)}<section>${content}</section></div>`;
}

/** Basecoat empty state. */
export function empty(title: string, text: H | string = ""): H {
  return html`<div class="empty"><header><figure>${icon("inbox")}</figure><h3>${title}</h3>${text ? html`<p>${text}</p>` : ""}</header></div>`;
}

/** Status badge: a Basecoat outline badge with a coloured dot for the state. */
export function badge(status: string): H {
  const tone: Record<string, string> = {
    draft: "neutral", sent: "info", partially_signed: "info", signed: "ok", finalized: "ok", declined: "bad", expired: "warn", revoked: "bad",
    pending: "neutral", notified: "info", viewed: "info", pending_approval: "warn", approved: "ok", delivered: "ok", failed: "bad", deactivated: "neutral", archived: "neutral",
  };
  return html`<span class="badge" data-variant="outline"><span class="dot" data-tone="${tone[status] ?? "neutral"}"></span>${status.replace(/_/g, " ")}</span>`;
}

export function when(iso: string | null | undefined): H {
  if (!iso) return html`<span class="muted">–</span>`;
  const d = new Date(iso);
  return html`<time datetime="${iso}" title="${iso}">${d.toISOString().slice(0, 16).replace("T", " ")} UTC</time>`;
}

export function issuesList(issues: { message: string; field?: string }[]): H {
  return html`<ul>${issues.map((i) => html`<li>${i.field ? html`<code>${i.field}</code>: ` : ""}${i.message}</li>`)}</ul>`;
}

export function csrfInput(csrf: string): H {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}
