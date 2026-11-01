import type { Issue } from "./errors.ts";
import type { FormatOptions } from "./format.ts";
import { parseTemplate, type FieldDef } from "./placeholders.ts";
import { resolveValues } from "./resolve.ts";
import { computeRevision } from "./revision.ts";
import { validateSigners, type Signer } from "./signers.ts";
import { validateValues, type FieldValue } from "./values.ts";

export interface PrepareInput {
  /** Template or inline Markdown, optionally with front matter. */
  source: string;
  values?: Record<string, unknown>;
  signers?: unknown;
  format?: FormatOptions;
  settings?: Record<string, string | number | boolean | null>;
}

export interface PreparedDocument {
  valid: boolean;
  issues: Issue[];
  fields: FieldDef[];
  values: Record<string, FieldValue>;
  signers: Signer[];
  /** Markdown with template values filled in. Signer fields remain as placeholders. */
  content: string;
  revision: string;
}

/** Parse, validate, and resolve a document draft. Pure: no I/O. */
export function prepareDocument(input: PrepareInput): PreparedDocument {
  const parsed = parseTemplate(input.source);
  const v = validateValues(parsed.fields, input.values ?? {});
  const s = validateSigners(parsed.fields, input.signers);
  const content = resolveValues(parsed, v.values, input.format);
  const issues = [...parsed.issues, ...v.issues, ...s.issues];
  const revisionInput = { content, values: v.values, signers: s.signers };
  return {
    valid: issues.length === 0,
    issues,
    fields: parsed.fields,
    values: v.values,
    signers: s.signers,
    content,
    revision: computeRevision(input.settings ? { ...revisionInput, settings: input.settings } : revisionInput),
  };
}
