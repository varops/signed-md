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

let assetVersion = "";

/** Set once at startup from a hash of the assets, so browsers fetch new CSS and JS after an upgrade. */
export function setAssetVersion(v: string): void {
  assetVersion = v;
}

/** Link to a bundled asset, versioned by its content. */
export function asset(path: string): string {
  return `/assets/${path}${assetVersion ? `?v=${assetVersion}` : ""}`;
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

/** The footer on public pages (login, signing): "Powered by" our logo, then Privacy policy (hosted) or Source. */
export function footer(): H {
  // "Powered by" with our logo (unless branding is off). Under it, the privacy policy on the hosted
  // service, or the source link on self-hosted servers (AGPL-3.0 section 13).
  const powered = branding
    ? html`<div class="row foot-powered">Powered by<a class="foot-logo" href="${PRODUCT_URL}" target="_blank" rel="noopener" aria-label="Signed.md"><img class="logo-light" src="${asset("logo-light.svg")}" alt="" width="60" height="24"><img class="logo-dark" src="${asset("logo-dark.svg")}" alt="" width="60" height="24"></a></div>`
    : "";
  const link = hosted ? html`<a href="${PRODUCT_URL}/privacy" target="_blank" rel="noopener">Privacy policy</a>` : html`<a href="${sourceUrl}" target="_blank" rel="noopener">Source</a>`;
  return html`<footer class="site-foot">${powered}${link}</footer>`;
}

export interface ShellOptions {
  title: string;
  user?: { email: string; name: string; role: "owner" | "admin" | "member" | "viewer"; theme?: "system" | "light" | "dark"; avatar?: string | null } | null;
  /** Contracts left under the plan's limit (hosted). Null hides the counter. */
  usage?: { kind: "monthly" | "total"; limit: number; left: number; level: "ok" | "low" | "out"; url: string } | null;
  csrf?: string;
  active?: string;
  flash?: { kind: "ok" | "bad" | "warn" | "info"; text: string } | null;
  /** Use the full width (editors and document pages) instead of the centred column. */
  full?: boolean;
  /** The sidebar was collapsed (remembered in a cookie, so there is no flash on load). */
  collapsed?: boolean;
}

type NavRole = "owner" | "admin" | "member" | "viewer";
type NavItem = [key: string, href: string, label: string, icon: keyof typeof ICONS, roles: NavRole[]];
const ALL: NavRole[] = ["owner", "admin", "member", "viewer"];
/** The sidebar: what you make, what you manage, then the Outbox (self-hosted only). */
const NAV: { label: string | null; items: NavItem[]; featured?: boolean }[] = [
  // Agents first and highlighted: working with agents is what Signed.md is for.
  { label: null, featured: true, items: [["agentic", "/agentic", "Agents", "bot", ALL]] },
  { label: "Create", items: [["documents", "/documents", "Documents", "file", ALL], ["templates", "/templates", "Templates", "template", ALL]] },
  { label: "Manage", items: [["team", "/team", "Team", "users", ["owner", "admin"]], ["settings", "/settings", "Settings", "settings", ALL], ["activity", "/activity", "Activity", "activity", ["owner", "admin", "viewer"]]] },
  { label: null, items: [["outbox", "/outbox", "Outbox", "inbox", ["owner", "admin"]]] },
];

/** The browser's bar colour: the same as the mobile top bar (light #f9f9f9, dark #111113), following the person's theme. */
function themeColor(scheme: "system" | "light" | "dark"): H {
  const light = "#f9f9f9", dark = "#111113";
  if (scheme !== "system") return html`<meta name="theme-color" content="${scheme === "dark" ? dark : light}">`;
  return html`<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`;
}

/** <head> shared by every page: Oat UI, our styles, and the colour scheme. */
export function head(title: string, scheme: "system" | "light" | "dark" = "system"): H {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme === "system" ? "light dark" : scheme}">
${themeColor(scheme)}
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Signed.md">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="apple-touch-icon" sizes="512x512" href="/apple-touch-icon.png">
<meta name="robots" content="noindex, follow">
<title>${title}</title>
<link rel="stylesheet" href="${asset("vendor/oat.css")}">
<link rel="stylesheet" href="${asset("app.css")}">
<script src="${asset("vendor/oat.js")}" defer></script>
<link rel="icon" href="${asset("icon.svg")}" type="image/svg+xml">`;
}

/** The Signed.md logo, light or dark to match the page's colour scheme (see .brand in app.css). */
export function logo(href: string, label = "Signed.md"): H {
  return html`<a class="brand" href="${href}"><img class="logo-light" src="${asset("logo-light.svg")}" alt="${label}" width="70" height="28"><img class="logo-dark" src="${asset("logo-dark.svg")}" alt="${label}" width="70" height="28"></a>`;
}

export function shell(opts: ShellOptions, body: H): H {
  const user = opts.user;
  return html`<!doctype html>
<html lang="en">
<head>
${head(`${opts.title} · Signed.md`, user?.theme ?? "system")}
</head>
<body>
${user
  ? html`<div class="app" ${opts.collapsed ? html`data-collapsed` : ""}>
  ${sidebar(opts, user)}
  <div class="app-main">
    <main class="wrap${opts.full ? " full" : ""}" id="main">
${opts.flash ? alert(opts.flash.kind, opts.flash.text) : ""}
${body}
    </main>
  </div>
</div>`
  : html`<main class="wrap" id="main">
${opts.flash ? alert(opts.flash.kind, opts.flash.text) : ""}
${body}
</main>
${footer()}`}
<script src="${asset("app.js")}" defer></script>
</body>
</html>`;
}

/** The left sidebar: logo, navigation, and at the bottom the plan's usage, the person, and the source link. */
function sidebar(opts: ShellOptions, user: NonNullable<ShellOptions["user"]>): H {
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(([k, , , , roles]) => roles.includes(user.role) && !(hosted && k === "outbox")) })).filter((g) => g.items.length);
  return html`<aside class="sidebar" id="sidebar" aria-label="Sidebar">
    <div class="sidebar-head">
      ${logo("/documents")}
      <button type="button" class="rail-logo" data-smd-sidebar-toggle aria-controls="sidebar" aria-expanded="${opts.collapsed ? "false" : "true"}" aria-label="Expand the sidebar"><img src="${asset("icon.svg")}" alt="" width="28" height="28"></button>
      <button type="button" class="ghost icon sidebar-toggle" data-smd-sidebar-toggle aria-controls="sidebar" aria-expanded="${opts.collapsed ? "false" : "true"}" aria-label="Collapse the sidebar">${icon("panelLeft")}</button>
      <button type="button" class="ghost icon menu-toggle" aria-controls="sidebar" aria-expanded="false" aria-label="Menu">${icon("menu")}${icon("close")}</button>
    </div>
    <nav class="side-nav" aria-label="Main">
      ${groups.map((g, i) => html`${!g.label && i && !g.featured ? html`<hr>` : ""}${g.label ? html`<p class="nav-label" id="nav-${g.label.toLowerCase()}">${g.label}</p>` : ""}
        <ul ${g.label ? html`aria-labelledby="nav-${g.label.toLowerCase()}"` : ""} ${g.featured ? html`class="featured"` : ""}>${g.items.map(([k, href, label, ic]) => html`<li><a href="${href}" ${opts.active === k ? html`aria-current="page"` : ""} ${opts.collapsed ? html`title="${label}"` : ""}>${icon(ic)}<span>${label}</span></a></li>`)}</ul>`)}
    </nav>
    <footer class="sidebar-foot">
      ${opts.usage ? usagePill(opts.usage) : ""}
      ${sourceNote()}
      ${userMenu(user, opts.csrf ?? "")}
    </footer>
  </aside>`;
}

/** The person at the bottom of the sidebar, opening a menu with their settings and log out. */
function userMenu(user: NonNullable<ShellOptions["user"]>, csrf: string): H {
  const role = user.role === "admin" ? "Administrator" : user.role.charAt(0).toUpperCase() + user.role.slice(1);
  return html`<ot-dropdown class="user-menu">
    <button type="button" id="user-trigger" class="ghost" popovertarget="user-pop" aria-haspopup="menu" aria-label="Account: ${user.name}, ${user.email}">${avatarFigure(user.name, user.avatar, "small")}<span class="user-text" aria-hidden="true"><strong>${user.name}</strong><span class="tiny muted">${role}</span></span>${icon("chevronsUpDown")}</button>
    <div popover id="user-pop" class="account-pop" role="menu" aria-labelledby="user-trigger">
      <div class="account-head" aria-hidden="true">${avatarFigure(user.name, user.avatar)}<p><strong>${user.name}</strong><span class="small muted">${user.email}</span></p></div>
      ${hosted ? html`<a role="menuitem" href="${HOSTED_APP_URL}/account">${icon("account")} Manage account</a>` : html`<a role="menuitem" href="/settings">${icon("account")} Your settings</a>`}
      <form method="post" action="/logout" role="none">${csrfInput(csrf)}<button type="submit" role="menuitem" class="ghost">${icon("logout")} Log out</button></form>
    </div>
  </ot-dropdown>`;
}

/** The AGPL source link (section 13), small, at the bottom of the sidebar. */
function sourceNote(): H {
  return branding
    ? html`<p class="source-note">Powered by <a href="${PRODUCT_URL}" target="_blank" rel="noopener">Signed.md</a><br><a href="${sourceUrl}" target="_blank" rel="noopener">Source</a> (AGPL-3.0)</p>`
    : html`<p class="source-note">Open source<br><a href="${sourceUrl}" target="_blank" rel="noopener">Source</a> (AGPL-3.0)</p>`;
}

/** Contracts left, linking to billing. Shown only when the plan has a limit. */
function usagePill(u: NonNullable<ShellOptions["usage"]>): H {
  const text = u.left === 0 ? "No contracts left" : `${u.left} of ${u.limit} left${u.kind === "monthly" ? " this month" : ""}`;
  const title = u.kind === "monthly" ? `Your plan includes ${u.limit} contracts a month. Upgrade for more.` : `Your plan includes ${u.limit} contracts. Upgrade for more.`;
  return html`<a class="usage-pill" data-level="${u.level}" href="${u.url}" title="${title}" aria-label="${text}. ${title}">${text}</a>`;
}

/** An avatar: initials, with the picture on top when there is one (app.js drops a picture that fails). */
export function avatarFigure(name: string, url: string | null | undefined, size: "small" | "" | "large" = "", tooltip?: string): H {
  if (tooltip) return html`<figure data-variant="avatar" class="${size}" title="${tooltip}" aria-label="${tooltip}"><abbr aria-hidden="true">${initialsOf(name)}</abbr>${url ? html`<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</figure>`;
  return html`<figure data-variant="avatar" class="${size}" aria-label="${name}"><abbr title="${name}" aria-hidden="true">${initialsOf(name)}</abbr>${url ? html`<img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</figure>`;
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
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  signature: '<path d="m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284"/><path d="M3 21h18"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  declined: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  unarchive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  userMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  userCheck: '<path d="m16 11 2 2 4-4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  sliders: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  consent: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  crown: '<path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.6a1 1 0 0 0 1.52.29l4.27-3.66a.5.5 0 0 1 .82.5l-2.83 10.25a1 1 0 0 1-.96.75H5.8a1 1 0 0 1-.96-.75L2.02 5.99a.5.5 0 0 1 .82-.5l4.27 3.66a1 1 0 0 0 1.52-.29z"/><path d="M5 21h14"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  template: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  minus: '<path d="M5 12h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
} as const;

export function icon(name: keyof typeof ICONS): H {
  return raw(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
}

/**
 * Alerts. Problems use role="alert" (announced at once); everything else is a role="status" note.
 * The icon repeats the meaning, so colour is never the only cue.
 */
export function alert(kind: "ok" | "info" | "warn" | "bad", content: H | string): H {
  const variant = { ok: "success", info: "", warn: "warning", bad: "error" }[kind];
  return html`<div role="${kind === "bad" ? "alert" : "status"}" class="note" ${variant ? html`data-variant="${variant}"` : ""}>${icon(kind)}<div>${content}</div></div>`;
}

/** Empty state. */
export function empty(title: string, text: H | string = ""): H {
  return html`<div class="empty">${icon("inbox")}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ""}</div>`;
}

/** Status badge: an outline badge with a coloured dot; the word carries the meaning. */
export function badge(status: string, label?: string): H {
  const tone: Record<string, string> = {
    draft: "neutral", sent: "info", partially_signed: "info", signed: "ok", finalized: "ok", declined: "bad", expired: "warn", revoked: "bad",
    pending: "neutral", notified: "info", viewed: "info", pending_approval: "warn", approved: "ok", delivered: "ok", failed: "bad", deactivated: "neutral", archived: "neutral",
  };
  return html`<span class="badge outline"><span class="dot" data-tone="${tone[status] ?? "neutral"}" aria-hidden="true"></span>${label ?? status.replace(/_/g, " ")}</span>`;
}

/** A labelled form control. The label points at the control, and hints are linked with aria-describedby. */
export function field(id: string, label: H | string, control: H, hint?: H | string): H {
  return html`<div data-field><label for="${id}">${label}</label>${control}${hint ? html`<small data-hint id="${id}-hint">${hint}</small>` : ""}</div>`;
}

export function when(iso: string | null | undefined): H {
  if (!iso) return html`<span class="muted">–</span>`;
  const d = new Date(iso);
  const t = d.toISOString();
  return html`<time datetime="${iso}" title="${iso}">${t.slice(0, 10)}<span class="time"> ${t.slice(11, 16)} UTC</span></time>`;
}

export function issuesList(issues: { message: string; field?: string }[]): H {
  return html`<ul>${issues.map((i) => html`<li>${i.field ? html`<code>${i.field}</code>: ` : ""}${i.message}</li>`)}</ul>`;
}

export function csrfInput(csrf: string): H {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

type Tone = "success" | "danger" | "warning" | undefined;
const EVENT_ICONS: Record<string, [keyof typeof ICONS, Tone?]> = {
  "document.created": ["plus"],
  "document.updated": ["pencil"],
  "document.approved": ["ok", "success"],
  "document.inline_approved": ["ok", "success"],
  "document.converted_to_inline": ["pencil", "warning"],
  "document.sent": ["send"],
  "document.revoked": ["ban", "danger"],
  "document.archived": ["archive"],
  "document.unarchived": ["unarchive"],
  "document.signed": ["ok", "success"],
  "document.finalized": ["package", "success"],
  "document.expired": ["clock", "warning"],
  "signer.notified": ["mail"],
  "signer.link_resent": ["mail"],
  "signer.reminded": ["mail"],
  "signer.viewed": ["eye"],
  "signer.downloaded_review_copy": ["file"],
  "signer.consented": ["consent"],
  "signer.signed": ["signature", "success"],
  "signer.declined": ["declined", "danger"],
  "team.invited": ["userPlus"],
  "team.invite_resent": ["mail"],
  "team.invite_revoked": ["userMinus", "danger"],
  "team.joined": ["userCheck", "success"],
  "team.role_changed": ["shield"],
  "team.deactivated": ["userMinus", "danger"],
  "team.reactivated": ["userCheck"],
  "settings.updated": ["sliders"],
  "apikey.created": ["key"],
  "apikey.revoked": ["key", "danger"],
  "template.created": ["plus"],
  "template.version_created": ["pencil"],
  "template.approved": ["ok", "success"],
  "template.archived": ["archive"],
  "template.unarchived": ["unarchive"],
  "password.reset": ["key"],
  "folder.created": ["folder"],
  "folder.renamed": ["pencil"],
  "folder.deleted": ["trash", "danger"],
};

/** The round icon on a timeline entry: what kind of event it was. Decorative; the text says it too. */
export function eventIcon(type: string): H {
  const [name, tone] = EVENT_ICONS[type] ?? ["dot"];
  return html`<span class="tl-icon" ${tone ? html`data-tone="${tone}"` : ""}>${icon(name)}</span>`;
}
