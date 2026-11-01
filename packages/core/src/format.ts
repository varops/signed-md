import type { FieldDef } from "./placeholders.ts";
import type { FieldValue } from "./values.ts";

export interface FormatOptions {
  locale?: string;
}

/**
 * Escape text so Markdown renders it literally, while keeping it readable.
 * Inline syntax characters are always escaped. Block markers ("- ", "1. ", "> ")
 * only matter at the start of a line, so they are escaped only there.
 */
export function escapeMarkdown(s: string): string {
  let out = s.replace(/[\\`*_{}\[\]()<>#|~!&]/g, "\\$&");
  out = out.replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");
  return out;
}

/** Human-readable text for a value, before Markdown escaping. */
export function formatValue(def: FieldDef, value: FieldValue, opts: FormatOptions = {}): string {
  const locale = opts.locale ?? "en-US";
  switch (def.type) {
    case "currency":
      return new Intl.NumberFormat(locale, { style: "currency", currency: def.param ?? "USD" }).format(
        value as unknown as number, // Intl accepts exact decimal strings.
      );
    case "number":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(value as unknown as number);
    case "date": {
      const [y, m, d] = String(value).split("-").map(Number) as [number, number, number];
      return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    case "checkbox":
      return value ? "☑" : "☐";
    default:
      return String(value);
  }
}

/** Markdown for a value. Long text keeps its line breaks. */
export function valueToMarkdown(def: FieldDef, value: FieldValue, opts: FormatOptions = {}): string {
  const text = formatValue(def, value, opts);
  if (def.type === "longtext") {
    return text
      .split("\n")
      .map((line) => escapeMarkdown(line))
      .join("\\\n");
  }
  return escapeMarkdown(text);
}
