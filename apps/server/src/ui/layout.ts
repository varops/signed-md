import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ShellOptions {
  title: string;
  user?: { email: string } | null;
  csrf?: string;
  active?: string;
  flash?: { kind: "ok" | "bad" | "warn" | "info"; text: string } | null;
}

const NAV = [
  ["documents", "/documents", "Documents"],
  ["templates", "/templates", "Templates"],
  ["settings", "/settings", "Settings"],
  ["outbox", "/outbox", "Outbox"],
] as const;

export function shell(opts: ShellOptions, body: H): H {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Signed.md</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="data:image/svg+xml,${raw(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1c1917"/><path d="M8 20c3-6 5-9 7-9s0 9 2 9 3-5 7-5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>'))}">
</head>
<body>
${opts.user
  ? html`<header class="topbar">
  <a class="brand" href="/documents">Signed<span>.md</span></a>
  <nav class="nav">${NAV.map(([k, href, label]) => html`<a href="${href}" class="${opts.active === k ? "active" : ""}">${label}</a>`)}</nav>
  <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${opts.csrf ?? ""}"><button class="btn small" title="${opts.user.email}">Log out</button></form>
</header>`
  : ""}
<main class="wrap">
${opts.flash ? html`<div class="notice ${opts.flash.kind}">${opts.flash.text}</div>` : ""}
${body}
</main>
<script src="/assets/app.js" defer></script>
</body>
</html>`;
}

export function badge(status: string): H {
  const kind: Record<string, string> = {
    draft: "", sent: "info", partially_signed: "info", signed: "ok", finalized: "ok", declined: "bad", expired: "warn", revoked: "bad",
    pending: "", notified: "info", viewed: "info", pending_approval: "warn", approved: "ok", delivered: "ok", failed: "bad",
  };
  return html`<span class="badge ${kind[status] ?? ""}">${status.replace(/_/g, " ")}</span>`;
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
