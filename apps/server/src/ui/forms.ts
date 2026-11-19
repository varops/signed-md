import type { FieldDef } from "@signed-md/core";
import { html } from "hono/html";
import { field, type H } from "./layout.ts";

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
    .map(([, r]) => ({ key: r.key ?? "", name: r.name ?? "", email: r.email ?? "", order: r.order === undefined || r.order === "" || !Number.isFinite(Number(r.order)) ? 1 : Number(r.order) }))
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
  const id = `v-${f.name}`;
  const label = f.rules.label ?? f.name!;
  const hint = [
    f.type,
    f.type === "currency" ? f.param : null,
    f.rules.minimum !== undefined ? `min ${f.rules.minimum}` : null,
    f.rules.maximum !== undefined ? `max ${f.rules.maximum}` : null,
    Array.isArray(f.rules.allowed_values) ? `one of ${f.rules.allowed_values.join(", ")}` : null,
    f.rules.default !== undefined ? `default ${String(f.rules.default)}` : null,
  ].filter(Boolean).join(" · ");
  const v = current === undefined || current === null ? "" : String(current);
  const described = html`aria-describedby="${id}-hint"`;
  if (f.type === "checkbox") {
    return html`<div data-field><label><input type="checkbox" name="${name}" id="${id}" ${described} ${current === true || current === "on" ? "checked" : ""}> ${label}</label><small data-hint id="${id}-hint">${hint}</small></div>`;
  }
  let input: H;
  if (f.type === "longtext") input = html`<textarea name="${name}" id="${id}" ${described}>${v}</textarea>`;
  else if (f.type === "date") input = html`<input type="date" name="${name}" id="${id}" value="${v}" ${described}>`;
  else if (f.type === "choice" || Array.isArray(f.rules.allowed_values)) {
    const opts = (f.rules.options ?? f.rules.allowed_values ?? []).map(String);
    input = html`<select name="${name}" id="${id}" ${described}><option value="">Choose…</option>${opts.map((o) => html`<option ${o === v ? "selected" : ""}>${o}</option>`)}</select>`;
  } else input = html`<input type="text" name="${name}" id="${id}" value="${v}" ${described} ${f.type === "number" || f.type === "currency" ? html`inputmode="decimal"` : ""}>`;
  return field(id, label, input, hint);
}

export function signerRows(signers: { key: string; name: string; email: string; order: number }[], fixedKeys: boolean): H {
  const rows = signers.length ? signers : [{ key: "", name: "", email: "", order: 1 }];
  return html`<ol id="signers" class="signer-list" aria-describedby="signers-hint">
    ${rows.map(
      (s, i) => html`<li class="signer-row"><fieldset>
        ${fixedKeys && s.key
          ? // The template sets the key, so it is a heading here, not a field.
            html`<legend>Signer <code class="signer-key">${s.key}</code> <span class="muted">(#${i + 1})</span></legend><input type="hidden" name="signers[${i}][key]" value="${s.key}">`
          : html`<legend>Signer ${i + 1}</legend>
        ${field(`signer-${i}-key`, "Signer key", html`<input type="text" id="signer-${i}-key" name="signers[${i}][key]" value="${s.key}" placeholder="client" autocapitalize="none" autocorrect="off" spellcheck="false">`)}`}
        <div class="inline-fields">
          ${field(`signer-${i}-name`, "Name", html`<input type="text" id="signer-${i}-name" name="signers[${i}][name]" value="${s.name}" placeholder="Jane Doe" autocomplete="off">`)}
          ${field(`signer-${i}-email`, "Email", html`<input type="email" id="signer-${i}-email" name="signers[${i}][email]" value="${s.email}" placeholder="jane@example.com" autocomplete="off" autocapitalize="none" spellcheck="false">`)}
          ${field(`signer-${i}-order`, "Order", html`<input type="number" min="0" id="signer-${i}-order" name="signers[${i}][order]" value="${s.order}" data-signer-order>`)}
        </div>
      </fieldset></li>`,
    )}
  </ol>
  <p class="small muted" id="signers-hint">Signers with the same order sign at the same time. Lower orders sign first. 0 means any order (everyone signs at once), for every signer or none.</p>`;
}
