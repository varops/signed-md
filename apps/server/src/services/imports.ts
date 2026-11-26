import { SignedError } from "@signed-md/core";
import type { Format } from "@firecrawl/anydoc";

/**
 * Start a template or an inline document from an existing contract: Word (.docx, .doc), OpenDocument,
 * RTF or PDF, converted to Markdown with Firecrawl's AnyDoc (MIT). Conversion is fully local: no
 * document leaves the server. Scanned PDFs need OCR, which is not available yet.
 */

export const MAX_IMPORT_BYTES = 3 * 1024 * 1024;
// Format is a const enum whose values are these strings.
const ACCEPTED = ["docx", "doc", "odt", "rtf", "pdf"] as Format[];
export const IMPORT_ACCEPT = ".docx,.doc,.odt,.rtf,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/vnd.oasis.opendocument.text,application/rtf";

export interface Imported {
  markdown: string;
  /** A name for the template, from the first heading or the file name. */
  title: string;
}

export async function importDocument(fileName: string, bytes: Uint8Array): Promise<Imported> {
  if (bytes.length === 0) throw new SignedError("INVALID_REQUEST", "Choose a file to import");
  if (bytes.length > MAX_IMPORT_BYTES) throw new SignedError("INVALID_REQUEST", "The file must be at most 3 MB");
  const ext = fileName.includes(".") ? fileName.split(".").pop()! : "";
  // AnyDoc loads on the first import, not at start-up.
  const { formatFromBytes, formatFromExtension, toMarkdownBytes } = await import("@firecrawl/anydoc");
  const format = formatFromBytes(bytes) ?? formatFromExtension(ext);
  if (!format || !ACCEPTED.includes(format)) throw new SignedError("INVALID_REQUEST", "Import a Word (.docx or .doc), OpenDocument (.odt), RTF or PDF file");

  let markdown: string;
  try {
    markdown = await toMarkdownBytes(bytes, format, { ocr: "reject" });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const pages = (e as { pages?: number[] }).pages;
    const message =
      code === "needsOcr"
        ? `This PDF is scanned${pages?.length ? ` (page${pages.length > 1 ? "s" : ""} ${pages.join(", ")})` : ""}, so its text can't be read. Import the original Word file, or a PDF with selectable text.`
        : code === "encrypted"
          ? "This file is password-protected. Remove the password and try again."
          : "This file couldn't be converted. Check that it opens correctly, or import it in another format.";
    throw new SignedError("INVALID_REQUEST", message);
  }

  markdown = cleanUp(markdown);
  if (!markdown.trim()) throw new SignedError("INVALID_REQUEST", "No text was found in this file");
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const fromName = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return { markdown, title: (heading || fromName || "Imported document").slice(0, 120) };
}

/** Make converted Markdown safe and tidy for Signed.md. */
function cleanUp(md: string): string {
  return (
    md
      .replace(/\r\n?/g, "\n")
      // Literal double braces in the source are text, not placeholders.
      .replace(/(?<!\\)\{\{/g, "\\{{")
      // Images can't be signed content (and would be fetched from elsewhere): drop them.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
