import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { Signer } from "./signers.ts";
import type { FieldValue } from "./values.ts";

export interface RevisionInput {
  /** Markdown with template values resolved. */
  content: string;
  values: Record<string, FieldValue>;
  signers: Signer[];
  /** Any other settings that change what signers see or how the document is sent. */
  settings?: Record<string, string | number | boolean | null>;
}

/** A revision identifies the exact draft a human approved. Any change produces a new one. */
export function computeRevision(input: RevisionInput): string {
  const signers = [...input.signers]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((s) => ({ key: s.key, name: s.name, email: s.email, order: s.order }));
  const hash = sha256Hex(canonicalJson({ v: 1, content: input.content, values: input.values, signers, settings: input.settings ?? {} }));
  return `rev_${hash.slice(0, 32)}`;
}
