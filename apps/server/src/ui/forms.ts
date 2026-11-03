import type { FieldDef } from "@signed-md/core";
import { html } from "hono/html";
import type { H } from "./layout.ts";

export type FormBody = Record<string, string | File | (string | File)[]>;

export function str(body: FormBody, name: string): string {
  const v = body[name];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
}

/** Parse rows named signers[0][key], signers[0][name], ... */
export function parseSigners(body: FormBody): { key: string; name: string; email: string; order: number }[] {
  const rows = new Map<number, Record<string, string>>();
  for (const [k, v] of Object.entries(body)) {
    const m = /^signers\[(\d+)\]\[(key|name|email|order)\]$/.exec(k);
    if (!m || typeof v !== "string") continue;
    const i = Number(m[1]);
    rows.set(i, { ...rows.get(i), [m[2]!]: v.trim() });
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => ({ key: r.key ?? "", name: r.name ?? "", email: r.email ?? "", order: Number(r.order || 1) || 1 }))
    .filter((r) => r.key || r.name || r.email);
}

/** Template values from inputs named v:<name>. Empty inputs are left out so defaults apply. */
export function parseValues(body: FormBody, fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind !== "value") continue;
    const raw = str(body, `v:${f.name}`);
    if (f.type === "checkbox") out[f.name!] = raw === "on";
    else if (raw.trim() !== "") out[f.name!] = raw;
  }
  return out;
}

export function valueInput(f: FieldDef, current: unknown): H {
  const name = `v:${f.name}`;
  const label = f.rules.label ?? f.name!;
  const hint = [
    f.type === "currency" ? f.param : null,
    f.rules.minimum !== undefined ? `min ${f.rules.minimum}` : null,
    f.rules.maximum !== undefined ? `max ${f.rules.maximum}` : null,
    Array.isArray(f.rules.allowed_values) ? `one of ${f.rules.allowed_values.join(", ")}` : null,
    f.rules.default !== undefined ? `default ${String(f.rules.default)}` : null,
  ].filter(Boolean).join(" · ");
  const v = current === undefined || current === null ? "" : String(current);
  let input: H;
  if (f.type === "longtext") input = html`<textarea class="textarea" name="${name}" id="${name}">${v}</textarea>`;
  else if (f.type === "date") input = html`<input class="input" type="date" name="${name}" id="${name}" value="${v}">`;
  else if (f.type === "checkbox") input = html`<label class="check"><input class="input" type="checkbox" name="${name}" ${current === true || current === "on" ? "checked" : ""}> Yes</label>`;
  else if (f.type === "choice" || Array.isArray(f.rules.allowed_values)) {
    const opts = (f.rules.options ?? f.rules.allowed_values ?? []).map(String);
    input = html`<select class="select" name="${name}" id="${name}"><option value="">Choose…</option>${opts.map((o) => html`<option ${o === v ? "selected" : ""}>${o}</option>`)}</select>`;
  } else input = html`<input class="input" type="text" name="${name}" id="${name}" value="${v}" ${f.type === "number" || f.type === "currency" ? html`inputmode="decimal"` : ""}>`;
  return html`<div class="field"><label for="${name}">${label} <span class="muted">${f.type}${hint ? ` · ${hint}` : ""}</span></label>${input}</div>`;
}

export function signerRows(signers: { key: string; name: string; email: string; order: number }[], fixedKeys: boolean): H {
  const rows = signers.length ? signers : [{ key: "", name: "", email: "", order: 1 }];
  return html`<div id="signers" class="stack">
    ${rows.map(
      (s, i) => html`<div class="signer-row">
        <div class="row" style="margin-bottom:8px"><label style="margin:0">Signer key</label>
          <input class="input" type="text" name="signers[${i}][key]" value="${s.key}" ${fixedKeys && s.key ? "readonly" : ""} style="max-width:180px" placeholder="client"></div>
        <div class="inline-fields">
          <div><label>Name</label><input class="input" type="text" name="signers[${i}][name]" value="${s.name}" placeholder="Jane Doe"></div>
          <div><label>Email</label><input class="input" type="email" name="signers[${i}][email]" value="${s.email}" placeholder="jane@example.com"></div>
          <div><label>Order</label><input class="input" type="number" min="1" name="signers[${i}][order]" value="${s.order}"></div>
        </div>
      </div>`,
    )}
  </div>
  <p class="small muted" style="margin-top:8px">Signers with the same order sign at the same time. Lower orders sign first.</p>`;
}
