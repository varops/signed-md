import type { Element, ElementContent, Root, Text } from "hast";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit, SKIP } from "unist-util-visit";
import { parseTemplate, type FieldDef } from "./placeholders.ts";

/** What to show for a signer field. Return null to render an empty, fillable slot. */
export type SignerFieldRenderer = (def: FieldDef) => ElementContent | null;

export interface RenderOptions {
  renderField?: SignerFieldRenderer;
  /** Field definitions from the original template, so front matter rules (labels) apply. */
  fields?: FieldDef[];
  /** Also render unresolved template values ({{$name:type}}) as slots. Used to preview templates. */
  valueSlots?: boolean;
}

const SENTINEL = /SMDFIELD(\d+)X/g;

function defaultSlot(def: FieldDef): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["smd-field", `smd-field-${def.type}`],
      dataField: def.key,
      dataSigner: def.signer ?? null,
      dataType: def.type,
    },
    children: [{ type: "text", value: def.rules.label ?? def.key }],
  };
}

/**
 * Render resolved Markdown (template values already filled in) to safe HTML.
 * Raw HTML in the Markdown is dropped and the output is sanitised. Signer fields
 * are injected after sanitising, as trusted elements.
 */
export function renderHtml(resolvedMarkdown: string, opts: RenderOptions = {}): string {
  const parsed = parseTemplate(resolvedMarkdown);
  const defs = new Map(parsed.fields.map((f) => [f.key, f]));
  for (const f of opts.fields ?? []) if (defs.has(f.key)) defs.set(f.key, f);
  const slots: FieldDef[] = [];

  // Swap each signer placeholder for an alphanumeric sentinel that Markdown leaves alone.
  let md = "";
  let pos = 0;
  for (const occ of parsed.occurrences) {
    const def = defs.get(occ.key)!;
    if (def.kind !== "signer" && !opts.valueSlots) continue;
    md += parsed.body.slice(pos, occ.start) + `SMDFIELD${slots.length}X`;
    slots.push(def);
    pos = occ.end;
  }
  md += parsed.body.slice(pos);

  const injectFields = () => (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined || !SENTINEL.test(node.value)) return;
      SENTINEL.lastIndex = 0;
      const parts: ElementContent[] = [];
      let last = 0;
      for (const m of node.value.matchAll(SENTINEL)) {
        if (m.index! > last) parts.push({ type: "text", value: node.value.slice(last, m.index) });
        const def = slots[Number(m[1])]!;
        const custom = opts.renderField?.(def);
        parts.push(custom ?? defaultSlot(def));
        last = m.index! + m[0].length;
      }
      if (last < node.value.length) parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return [SKIP, index + parts.length];
    });
  };

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm) // Tables are common in agreements (fee schedules).
    .use(remarkRehype) // allowDangerousHtml is off: raw HTML is dropped.
    .use(rehypeSanitize)
    .use(injectFields)
    .use(rehypeStringify)
    .processSync(md);
  return String(file);
}
