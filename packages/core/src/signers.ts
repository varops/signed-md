import type { Issue } from "./errors.ts";
import type { FieldDef } from "./placeholders.ts";

export interface SignerInput {
  key: string;
  name: string;
  email: string;
  order?: number;
}

export interface Signer {
  key: string;
  name: string;
  email: string;
  order: number;
}

const KEY = /^[a-z][a-z0-9_]*$/i;
// Deliberately simple: one "@", a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSigners(
  fields: FieldDef[],
  input: unknown,
): { signers: Signer[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const signers: Signer[] = [];

  if (!Array.isArray(input) || input.length === 0) {
    issues.push({ code: "SIGNER_INVALID", field: "signers", message: "At least one signer is required" });
    return { signers, issues };
  }

  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const path = `signers[${i}]`;
    if (typeof raw !== "object" || raw === null) {
      issues.push({ code: "SIGNER_INVALID", field: path, message: "Signer must be an object" });
      return;
    }
    const s = raw as Record<string, unknown>;
    const key = typeof s.key === "string" ? s.key.trim() : "";
    const name = typeof s.name === "string" ? s.name.trim() : "";
    const email = typeof s.email === "string" ? s.email.trim().toLowerCase() : "";
    const order = s.order === undefined ? 1 : s.order;

    let ok = true;
    if (!KEY.test(key)) {
      issues.push({ code: "SIGNER_INVALID", field: `${path}.key`, message: "Signer key must start with a letter and use letters, digits, or _" });
      ok = false;
    } else if (seen.has(key)) {
      issues.push({ code: "SIGNER_INVALID", field: `${path}.key`, message: `Signer key '${key}' is used more than once` });
      ok = false;
    }
    if (name === "") {
      issues.push({ code: "SIGNER_INVALID", field: `${path}.name`, message: `Signer '${key || i}' needs a name` });
      ok = false;
    }
    if (!EMAIL.test(email)) {
      issues.push({ code: "SIGNER_INVALID", field: `${path}.email`, message: `Signer '${key || i}' needs a valid email address` });
      ok = false;
    }
    if (typeof order !== "number" || !Number.isInteger(order) || order < 1) {
      issues.push({ code: "SIGNER_INVALID", field: `${path}.order`, message: "Signing order must be a positive integer" });
      ok = false;
    }
    seen.add(key);
    if (ok) signers.push({ key, name, email, order: order as number });
  });

  const used = new Map<string, string>();
  for (const f of fields) if (f.kind === "signer" && !used.has(f.signer!)) used.set(f.signer!, f.key);

  for (const [signerKey, firstField] of used) {
    if (!seen.has(signerKey)) {
      issues.push({
        code: "SIGNER_MISSING",
        field: firstField,
        message: `The document uses signer key '${signerKey}', but no signer has that key`,
      });
    }
  }
  for (const s of signers) {
    if (!used.has(s.key)) {
      issues.push({
        code: "SIGNER_INVALID",
        field: `signers.${s.key}`,
        message: `Signer '${s.key}' has no fields to complete in this document`,
      });
    }
  }

  return { signers, issues };
}

/** Group signers by order, ascending. Each group signs in parallel. */
export function signingGroups(signers: Signer[]): Signer[][] {
  const byOrder = new Map<number, Signer[]>();
  for (const s of signers) {
    const g = byOrder.get(s.order) ?? [];
    g.push(s);
    byOrder.set(s.order, g);
  }
  return [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}
