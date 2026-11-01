import { valueToMarkdown, type FormatOptions } from "./format.ts";
import type { ParsedTemplate } from "./placeholders.ts";
import type { FieldValue } from "./values.ts";

/**
 * Replace template values with their formatted text. Signer fields stay as placeholders,
 * so the result is still a valid template whose only fields belong to signers.
 */
export function resolveValues(
  parsed: ParsedTemplate,
  values: Record<string, FieldValue>,
  opts: FormatOptions = {},
): string {
  const defs = new Map(parsed.fields.map((f) => [f.key, f]));
  let out = "";
  let pos = 0;
  for (const occ of parsed.occurrences) {
    const def = defs.get(occ.key)!;
    if (def.kind !== "value") continue;
    const v = values[def.name!];
    if (v === undefined) continue; // Left as a placeholder; validation reports it.
    out += parsed.body.slice(pos, occ.start) + valueToMarkdown(def, v, opts);
    pos = occ.end;
  }
  return out + parsed.body.slice(pos);
}
