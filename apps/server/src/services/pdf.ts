import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type FieldDef, parseTemplate } from "@signed-md/core";
import type { Nodes, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { SignatureValue, SignerFieldValue } from "./signing.ts";

const run = promisify(execFile);

/** Escape text for Typst markup: every non-alphanumeric, non-space character gets a backslash. */
export function typstText(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, (c) => `\\${c}`).replace(/\n/g, " ");
}

/** Escape a string for a Typst string literal. */
function typstString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export interface PdfSigner {
  key: string;
  name: string;
  email: string;
  signed_at: string | null;
  ip: string | null;
}

export interface PdfInput {
  title: string;
  documentId: string;
  revision: string;
  /** Resolved Markdown with signer placeholders. */
  content: string;
  contentSha256: string;
  fields: FieldDef[];
  values: Map<string, SignerFieldValue>;
  signers: PdfSigner[];
  completedAt: string;
  accountName: string;
  publicUrl: string;
  keyId: string;
  timezone: string;
}

interface Asset {
  name: string;
  data: Buffer;
}

const SENTINEL = /SMDFIELD(\d+)X/g;

function fieldTypst(def: FieldDef, value: SignerFieldValue | undefined, assets: Asset[]): string {
  if (value === undefined) return `#box(stroke: (bottom: 0.5pt), width: 4cm)[#text(fill: gray)[${typstText(def.key)}]]`;
  if (typeof value === "object" && value !== null && "kind" in value) {
    const sig = value as SignatureValue;
    if (sig.kind === "drawn") {
      const name = `sig-${assets.length}.png`;
      assets.push({ name, data: Buffer.from(sig.image.split(",")[1] ?? "", "base64") });
      const h = def.type === "initials" ? "0.9cm" : "1.5cm";
      return `#box(baseline: 20%, stroke: (bottom: 0.5pt + gray), inset: (bottom: 2pt))[#image(${typstString(name)}, height: ${h})]`;
    }
    return `#box(stroke: (bottom: 0.5pt + gray), inset: (bottom: 2pt))[#text(size: 16pt, style: "italic")[${typstText(sig.text)}]]`;
  }
  if (def.type === "checkbox") return value ? "☑" : "☐";
  return typstText(String(value));
}

function inline(nodes: RootContent[], slots: FieldDef[], values: Map<string, SignerFieldValue>, assets: Asset[]): string {
  return nodes.map((n) => node(n, slots, values, assets)).join("");
}

function node(n: Nodes, slots: FieldDef[], values: Map<string, SignerFieldValue>, assets: Asset[]): string {
  const kids = (c: RootContent[]) => inline(c, slots, values, assets);
  switch (n.type) {
    case "root":
      return n.children.map((c) => node(c, slots, values, assets)).join("\n\n");
    case "text": {
      let out = "";
      let last = 0;
      for (const m of n.value.matchAll(SENTINEL)) {
        out += typstText(n.value.slice(last, m.index));
        const def = slots[Number(m[1])]!;
        out += fieldTypst(def, values.get(def.key), assets);
        last = m.index! + m[0].length;
      }
      return out + typstText(n.value.slice(last));
    }
    case "paragraph":
      return kids(n.children);
    case "heading":
      return `${"=".repeat(n.depth)} ${kids(n.children)}`;
    case "strong":
      return `#strong[${kids(n.children)}]`;
    case "emphasis":
      return `#emph[${kids(n.children)}]`;
    case "delete":
      return `#strike[${kids(n.children)}]`;
    case "inlineCode":
      return `#raw(${typstString(n.value)})`;
    case "code":
      return `#raw(block: true, ${typstString(n.value)})`;
    case "break":
      return " \\\n";
    case "thematicBreak":
      return "#line(length: 100%, stroke: 0.5pt + gray)";
    case "blockquote":
      return `#quote(block: true)[${n.children.map((c) => node(c, slots, values, assets)).join("\n\n")}]`;
    case "link":
      // Show the link text and the target, but do not make the PDF fetch anything.
      return `${kids(n.children)} (${typstText(n.url)})`;
    case "image":
    case "imageReference":
    case "html":
    case "definition":
    case "footnoteDefinition":
    case "yaml":
      return "";
    case "list": {
      const items = n.children.map((item) => {
        const body = item.children.map((c) => node(c, slots, values, assets)).join("\n\n");
        const check = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
        return `[${check}${body}]`;
      });
      return n.ordered
        ? `#enum(start: ${n.start ?? 1}, ${items.join(", ")})`
        : `#list(${items.join(", ")})`;
    }
    case "table": {
      const cols = n.children[0]?.children.length ?? 1;
      const cells = n.children.flatMap((row, ri) =>
        row.children.map((cell) => (ri === 0 ? `[#strong[${kids(cell.children)}]]` : `[${kids(cell.children)}]`)),
      );
      return `#table(columns: ${cols}, stroke: 0.5pt + gray, inset: 6pt, ${cells.join(", ")})`;
    }
    default:
      return "children" in n ? kids((n as { children: RootContent[] }).children) : "";
  }
}

function formatTime(iso: string | null, tz: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  const local = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "long", timeZone: tz }).format(d);
  return `${local} (${iso})`;
}

/** Build the Typst source and image assets for a completed agreement. */
export function buildTypst(input: PdfInput): { source: string; assets: Asset[] } {
  const parsed = parseTemplate(input.content);
  const defs = new Map(parsed.fields.map((f) => [f.key, f]));
  for (const f of input.fields) if (defs.has(f.key)) defs.set(f.key, f);
  const slots: FieldDef[] = [];
  let md = "";
  let pos = 0;
  for (const occ of parsed.occurrences) {
    const def = defs.get(occ.key)!;
    if (def.kind !== "signer") continue;
    md += parsed.body.slice(pos, occ.start) + `SMDFIELD${slots.length}X`;
    slots.push(def);
    pos = occ.end;
  }
  md += parsed.body.slice(pos);

  const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as Root;
  const assets: Asset[] = [];
  const body = node(tree, slots, input.values, assets);

  const footer = typstText(`${input.documentId} · ${input.revision}`);
  const signerRows = input.signers
    .map((s) => `[${typstText(s.name)}], [${typstText(s.email)}], [${typstText(formatTime(s.signed_at, input.timezone))}], [${typstText(s.ip ?? "–")}]`)
    .join(",\n  ");

  const source = `#set document(title: ${typstString(input.title)}, author: ${typstString(input.accountName)})
#set page(paper: "a4", margin: (x: 2.2cm, top: 2.2cm, bottom: 2.6cm), footer: context [
  #set text(size: 8pt, fill: gray)
  ${footer} #h(1fr) #counter(page).display("1 / 1", both: true)
])
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.65em)
#set heading(numbering: none)
#show heading: set block(above: 1.4em, below: 0.8em)

${body}

#pagebreak()
#text(size: 16pt, weight: "bold")[Signing certificate]

#v(0.5em)
#table(columns: (auto, 1fr), stroke: none, inset: (x: 0pt, y: 4pt),
  [*Document*], [${typstText(input.title)}],
  [*Document ID*], [${typstText(input.documentId)}],
  [*Revision*], [${typstText(input.revision)}],
  [*Content SHA-256*], [#text(size: 8pt)[${typstText(input.contentSha256)}]],
  [*Sent by*], [${typstText(input.accountName)}],
  [*Completed*], [${typstText(formatTime(input.completedAt, input.timezone))}],
  [*Signing key*], [${typstText(input.keyId)}],
)

#v(1em)
#text(weight: "bold")[Signers]
#table(columns: (1fr, 1.4fr, 1.6fr, auto), stroke: 0.5pt + gray, inset: 6pt,
  [*Name*], [*Email*], [*Signed*], [*IP address*],
  ${signerRows}
)

#v(1em)
#text(size: 9pt)[
  Each signer received a unique link by email, agreed to sign electronically, and completed their fields. Email delivery shows control of the email address. It does not by itself prove legal identity.

  This PDF is part of a completion package (ZIP) that contains the signed Markdown, the evidence log, and a manifest signed with this installation's key. Verify the package with: #raw("npx signed-md verify agreement.zip"). The public key is published at ${typstText(input.publicUrl)}/.well-known/signed-md-keys.json.
]
`;
  return { source, assets };
}

export async function renderPdf(typstBin: string, input: PdfInput): Promise<Buffer> {
  const { source, assets } = buildTypst(input);
  const dir = await mkdtemp(join(tmpdir(), "signedmd-pdf-"));
  try {
    await writeFile(join(dir, "main.typ"), source);
    for (const a of assets) await writeFile(join(dir, a.name), a.data);
    const created = Math.floor(Date.parse(input.completedAt) / 1000);
    await run(
      typstBin,
      ["compile", "--ignore-system-fonts", "--root", dir, "--creation-timestamp", String(created), join(dir, "main.typ"), join(dir, "out.pdf")],
      { timeout: 60_000 },
    );
    return await readFile(join(dir, "out.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
