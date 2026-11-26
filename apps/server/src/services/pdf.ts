import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ColumnsNode, type FieldDef, formatValue, groupColumns, parseTemplate } from "@signed-md/core";
import type { Nodes, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { SignatureValue, SignerFieldValue } from "./signing.ts";
import { CONTRACT_FONTS, type ContractFont } from "./fonts.ts";
import { ASSETS_DIR } from "../paths.ts";

const run = promisify(execFile);
/** Bundled fonts (OFL): STIX Two Text or Arimo (like Arial) for the agreement, Arimo for the certificate. */
const FONT_DIR = join(ASSETS_DIR, "fonts");

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
  order: number;
  notified_at: string | null;
  viewed_at: string | null;
  consented_at: string | null;
  signed_at: string | null;
  ip: string | null;
  user_agent: string | null;
  /** How the signer adopted their signature, if they had a signature field. */
  signature: SignerFieldValue | null;
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
  sender: { name: string; email: string } | null;
  source: string;
  sentAt: string | null;
  completedAt: string;
  accountName: string;
  publicUrl: string;
  keyId: string;
  timezone: string;
  /** Subject of the certificate that seals the PDF (PAdES). */
  sealedBy: string;
  /** Host of the timestamp authority, if timestamps are on. */
  timestampAuthority: string | null;
  disclosureVersion: string;
  /** Contract body font family. */
  font: ContractFont;
  /** An unsigned copy for review: marked as such, every signer field blank, no certificate page. */
  review?: boolean;
}

interface Asset {
  name: string;
  data: Buffer;
}

const SENTINEL = /SMDFIELD(\d+)X/g;

function fieldTypst(def: FieldDef, value: SignerFieldValue | undefined, assets: Asset[]): string {
  if (value === undefined) return `#box(stroke: (bottom: 0.5pt), width: 4cm)[#text(fill: rgb("#a8a29e"))[${typstText(def.key)}]]`;
  if (typeof value === "object" && value !== null && "kind" in value) {
    const sig = value as SignatureValue;
    if (sig.kind === "drawn") {
      const name = `sig-${assets.length}.png`;
      assets.push({ name, data: Buffer.from(sig.image.split(",")[1] ?? "", "base64") });
      const h = def.type === "initials" ? "0.9cm" : "1.5cm";
      return `#box(baseline: 20%, stroke: (bottom: 0.5pt + rgb("#a8a29e")), inset: (bottom: 2pt))[#image(${typstString(name)}, height: ${h})]`;
    }
    return `#box(stroke: (bottom: 0.5pt + rgb("#a8a29e")), inset: (bottom: 2pt, x: 2pt))[#text(size: 17pt, style: "italic")[${typstText(sig.text)}]]`;
  }
  if (def.type === "checkbox") return value ? "☑" : "☐";
  if (def.type === "date" && typeof value === "string") return typstText(formatValue(def, value, { locale: "en-GB" }));
  return typstText(String(value));
}

function inline(nodes: RootContent[], slots: FieldDef[], values: Map<string, SignerFieldValue>, assets: Asset[]): string {
  return nodes.map((n) => node(n, slots, values, assets)).join("");
}

function node(n: Nodes, slots: FieldDef[], values: Map<string, SignerFieldValue>, assets: Asset[]): string {
  const kids = (c: RootContent[]) => inline(c, slots, values, assets);
  if ((n as { type: string }).type === "columns") {
    // Side-by-side blocks (<!-- columns -->). Kept on one page so a signature row never splits.
    const cols = (n as unknown as ColumnsNode).children.map(
      (col) => `[\n${(col.children as RootContent[]).map((c) => node(c, slots, values, assets)).join("\n\n")}\n]`,
    );
    // A bit more room above, so a signature row is set apart from the text before it.
    return `#block(breakable: false, width: 100%, above: 2.2em, grid(columns: (${cols.map(() => "1fr").join(", ")},), column-gutter: 22pt, ${cols.join(", ")}))`;
  }
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
      return `#table(columns: (${Array(cols).fill("1fr").join(", ")},), stroke: 0.5pt + gray, inset: 6pt, ${cells.join(", ")})`;
    }
    default:
      return "children" in n ? kids((n as { children: RootContent[] }).children) : "";
  }
}

function formatTime(iso: string | null, tz: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: tz, timeZoneName: "short" }).format(d);
  return `${date}, ${time}`;
}

/** Shorten a user agent to something readable: browser and OS. */
function device(ua: string | null): string {
  if (!ua) return "–";
  const os = /Windows NT|Mac OS X|iPhone OS|Android|Linux/.exec(ua)?.[0]?.replace("Windows NT", "Windows").replace("Mac OS X", "macOS").replace("iPhone OS", "iOS") ?? "";
  const browser = /(Edg|Chrome|Firefox|Safari)\/[\d.]+/.exec(ua)?.[0]?.replace("Edg", "Edge").split(".")[0] ?? "";
  const short = [browser, os].filter(Boolean).join(" on ");
  return short || ua.slice(0, 80);
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
  groupColumns(tree);
  const assets: Asset[] = [];
  const body = node(tree, slots, input.values, assets);
  const t = (s: string) => typstText(s);
  const when = (iso: string | null) => t(formatTime(iso, input.timezone));

  const signatureBox = (sig: SignerFieldValue | null): string => {
    if (!sig || typeof sig !== "object" || !("kind" in sig)) return "";
    if (sig.kind === "drawn") {
      const name = `cert-sig-${assets.length}.png`;
      assets.push({ name, data: Buffer.from(sig.image.split(",")[1] ?? "", "base64") });
      return `#box(height: 1.1cm, image(${typstString(name)}, height: 1.1cm))`;
    }
    return `#text(font: "Nothing You Could Do", size: 18pt)[${t(sig.text)}]`;
  };

  const signerBlocks = input.signers
    .map((s) => {
      const adopted = s.signature && typeof s.signature === "object" && "kind" in s.signature ? (s.signature.kind === "drawn" ? "Drawn on device" : "Typed") : "–";
      return `#block(width: 100%, breakable: false, stroke: 0.5pt + rule, radius: 4pt, inset: 12pt, above: 10pt)[
  #grid(columns: (1fr, 1.15fr), column-gutter: 18pt,
    [
      #text(weight: "semibold", size: 10pt)[${t(s.name)}] \\
      #text(fill: muted)[${t(s.email)}]
      #v(6pt)
      #grid(columns: (auto, 1fr), column-gutter: 8pt, row-gutter: 5pt,
        text(fill: muted)[Signing order], [${s.order}],
        text(fill: muted)[Identified by], [Email link sent to ${t(s.email)}],
        text(fill: muted)[Signature], [${t(adopted)}],
      )
      #v(6pt)
      ${signatureBox(s.signature)}
    ],
    [
      #grid(columns: (auto, 1fr), column-gutter: 8pt, row-gutter: 5pt,
        text(fill: muted)[Sent], [${when(s.notified_at)}],
        text(fill: muted)[Viewed], [${when(s.viewed_at)}],
        text(fill: muted)[Agreed to disclosure], [${when(s.consented_at)}],
        text(fill: muted)[Signed], [${when(s.signed_at)}],
        text(fill: muted)[IP address], [${t(s.ip ?? "–")}],
        text(fill: muted)[Device], [${t(device(s.user_agent))}],
      )
    ],
  )
]`;
    })
    .join("\n");

  // The certificate of completion, on its own page after the contract (not in a review copy).
  const certificate = () => `#pagebreak()
#set text(font: "Arimo", size: 8.5pt)
#set par(leading: 0.6em, spacing: 0.9em)
#grid(columns: (1fr, auto), align: (left + bottom, right + bottom),
  text(size: 17pt, weight: "semibold")[Certificate of completion],
  box(fill: rgb("#dcfce7"), inset: (x: 8pt, y: 4pt), radius: 10pt)[#text(fill: rgb("#15803d"), weight: "semibold")[Completed]],
)
#text(fill: muted)[Signed electronically with Signed.md for ${t(input.accountName)}.]
#v(14pt)

#text(weight: "semibold", size: 10pt)[Document]
#v(2pt)
#line(length: 100%, stroke: 0.5pt + rule)
#grid(columns: (auto, 1fr), column-gutter: 14pt, row-gutter: 6pt,
  text(fill: muted)[Title], [${t(input.title)}],
  text(fill: muted)[Document ID], [${t(input.documentId)}],
  text(fill: muted)[Revision], [${t(input.revision)}],
  text(fill: muted)[Content SHA-256], [#text(font: "DejaVu Sans Mono", size: 7pt)[${t(input.contentSha256)}]],
  text(fill: muted)[Source], [${t(input.source)}],
  text(fill: muted)[Sent by], [${t(input.sender ? `${input.sender.name} (${input.sender.email}), ${input.accountName}` : input.accountName)}],
  text(fill: muted)[Sent], [${when(input.sentAt)}],
  text(fill: muted)[Completed], [${when(input.completedAt)}],
  text(fill: muted)[Signers], [${input.signers.length}],
)

#v(16pt)
#text(weight: "semibold", size: 10pt)[Signers]
#v(2pt)
#line(length: 100%, stroke: 0.5pt + rule)
${signerBlocks}

#v(16pt)
#block(breakable: false)[
#text(weight: "semibold", size: 10pt)[Integrity and verification]
#v(2pt)
#line(length: 100%, stroke: 0.5pt + rule)
#set par(spacing: 0.8em)
- This PDF is digitally sealed (PAdES) by #text(weight: "semibold")[${t(input.sealedBy)}]. If anyone changes it after sealing, PDF readers show the signature as invalid.
${input.timestampAuthority ? `- The seal and the evidence package carry trusted timestamps (RFC 3161) from ${t(input.timestampAuthority)}.` : ""}
- Each signer agreed to the electronic record and signature disclosure (version ${t(input.disclosureVersion)}) before signing. The exact text is in the evidence log.
- The evidence package (ZIP) holds the signed Markdown, this PDF, and a hash-chained evidence log, with a manifest signed by key ${t(input.keyId)}. Verify it offline with #raw("npx signed-md verify agreement.zip"). Public keys: ${t(input.publicUrl)}/.well-known/signed-md-keys.json.
- Each signer was identified by a unique link sent to their email address. This shows control of that email address. It does not by itself prove legal identity.
]`;
  const footer = t(`${input.review ? "Copy for review – not signed · " : ""}${input.documentId} · ${input.revision}`);
  const reviewNote = input.review
    ? `#block(width: 100%, fill: wash, inset: (x: 10pt, y: 8pt), radius: 4pt, below: 18pt)[#set text(font: "Arimo", size: 8pt, fill: muted)
#text(weight: "bold", fill: ink)[Copy for review – not signed.] The fields are left blank. Sign only through the link you were sent.]
`
    : "";
  const source = `#set document(title: ${typstString(input.title)}, author: ${typstString(input.accountName)})
#let ink = rgb("#1c1917")
#let muted = rgb("#78716c")
#let rule = rgb("#d6d3d1")
#let wash = rgb("#f5f5f4")
#set page(paper: "a4", margin: (x: 2.4cm, top: 2.4cm, bottom: 2.6cm), footer: context [
  #set text(font: "Arimo", size: 7pt, fill: muted)
  ${footer} #h(1fr) Page #counter(page).display() of #counter(page).final().first()
])
#set text(font: ${typstString(CONTRACT_FONTS[input.font].pdf)}, size: ${input.font === "sans-serif" ? "10pt" : "11.25pt"}${input.font === "serif" ? ", tracking: -0.005em" : ""}, fill: ink, lang: "en", hyphenate: false)
#set par(justify: false, leading: 0.72em, spacing: 1.15em)
#show heading: set text(weight: "bold", fill: ink)
#show heading.where(level: 1): it => block(below: 16pt)[#text(size: 19pt, it.body)]
#show heading.where(level: 2): it => block(above: 20pt, below: 9pt)[#text(size: 12.5pt, it.body)]
#show heading.where(level: 3): it => block(above: 16pt, below: 7pt)[#text(size: 10.5pt, it.body)]
#set list(indent: 4pt, body-indent: 8pt, spacing: 0.75em)
#set enum(indent: 4pt, body-indent: 8pt, spacing: 0.75em)
#set table(stroke: 0.5pt + rule, inset: (x: 8pt, y: 7pt), fill: (_, y) => if y == 0 { wash })
#show table: set par(justify: false)
#show table.cell.where(y: 0): set text(size: 9pt, weight: "bold")
#show raw: set text(font: "DejaVu Sans Mono", size: 9pt)
#show strong: set text(weight: "semibold")

${reviewNote}${body}
${input.review ? "" : certificate()}
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
      ["compile", "--ignore-system-fonts", "--font-path", FONT_DIR, "--pdf-standard", "a-2b", "--root", dir, "--creation-timestamp", String(created), join(dir, "main.typ"), join(dir, "out.pdf")],
      { timeout: 60_000 },
    );
    return await readFile(join(dir, "out.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
