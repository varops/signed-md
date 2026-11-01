import { compareDecimal, fractionDigits, padFraction, toDecimalString } from "./decimal.ts";
import type { Issue } from "./errors.ts";
import type { FieldDef } from "./placeholders.ts";

export type FieldValue = string | boolean;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_TEXT_MAX = 1_000;
const DEFAULT_LONGTEXT_MAX = 20_000;

export function currencyDigits(code: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function isValidDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

type Result = { ok: true; value: FieldValue } | { ok: false; message: string };

function fail(message: string): Result {
  return { ok: false, message };
}

/** Validate and normalise one value against its field definition. */
export function normalizeValue(def: FieldDef, input: unknown): Result {
  const label = def.key;
  const r = def.rules;

  let value: FieldValue;
  switch (def.type) {
    case "text":
    case "longtext": {
      if (typeof input !== "string") return fail(`${label} must be a string`);
      let s = input.normalize("NFC");
      if (def.type === "text") s = s.replace(/\s*\n\s*/g, " ");
      s = s.trim();
      if (s === "") return fail(`${label} must not be empty`);
      const max = r.max_length ?? (def.type === "text" ? DEFAULT_TEXT_MAX : DEFAULT_LONGTEXT_MAX);
      if (s.length > max) return fail(`${label} must be at most ${max} characters`);
      value = s;
      break;
    }
    case "number": {
      const d = toDecimalString(input);
      if (d === null) return fail(`${label} must be a number or a decimal string`);
      value = d;
      break;
    }
    case "currency": {
      if (typeof input === "number" && !Number.isInteger(input)) {
        return fail(`${label} must be a decimal string such as "1000.00", not a fractional number`);
      }
      const d = toDecimalString(input);
      if (d === null) return fail(`${label} must be a decimal string such as "1000.00"`);
      const digits = currencyDigits(def.param ?? "USD");
      if (fractionDigits(d) > digits) return fail(`${label} has more than ${digits} decimal places for ${def.param}`);
      value = padFraction(d, digits);
      break;
    }
    case "date": {
      if (typeof input !== "string" || !isValidDate(input.trim())) return fail(`${label} must be a date in YYYY-MM-DD format`);
      value = input.trim();
      break;
    }
    case "checkbox": {
      if (typeof input !== "boolean") return fail(`${label} must be true or false`);
      value = input;
      break;
    }
    case "choice": {
      if (typeof input !== "string") return fail(`${label} must be a string`);
      const options = (r.options ?? []).map(String);
      if (!options.includes(input)) return fail(`${label} must be one of: ${options.join(", ")}`);
      value = input;
      break;
    }
    case "signature":
    case "initials": {
      // Signer-only types are validated by the signing flow (see signing.ts).
      return fail(`${label} can only be completed by the signer`);
    }
  }

  // Range checks for ordered types.
  const ordered = def.type === "number" || def.type === "currency";
  if (ordered || def.type === "date") {
    const cmp = (a: string, b: string) => (ordered ? compareDecimal(a, b) : a < b ? -1 : a > b ? 1 : 0);
    const norm = (x: unknown) => (ordered ? toDecimalString(x) : typeof x === "string" ? x : null);
    if (r.minimum !== undefined) {
      const min = norm(r.minimum);
      if (min !== null && cmp(value as string, min) < 0) return fail(`${label} must be at least ${r.minimum}`);
    }
    if (r.maximum !== undefined) {
      const max = norm(r.maximum);
      if (max !== null && cmp(value as string, max) > 0) return fail(`${label} must be at most ${r.maximum}`);
    }
  }

  if (Array.isArray(r.allowed_values)) {
    const allowed = r.allowed_values.some((a) => {
      if (ordered) {
        const d = toDecimalString(a);
        return d !== null && compareDecimal(d, value as string) === 0;
      }
      return a === value;
    });
    if (!allowed) return fail(`${label} must be one of: ${r.allowed_values.join(", ")}`);
  }

  return { ok: true, value };
}

export interface ValueValidation {
  /** Normalised values keyed by name (without "$"). */
  values: Record<string, FieldValue>;
  issues: Issue[];
}

/**
 * Validate template values supplied by the sender. Keys are written without the "$" prefix.
 * Missing values fall back to front matter defaults.
 */
export function validateValues(fields: FieldDef[], input: Record<string, unknown>): ValueValidation {
  const issues: Issue[] = [];
  const values: Record<string, FieldValue> = {};
  const defs = new Map(fields.filter((f) => f.kind === "value").map((f) => [f.name!, f]));

  for (const key of Object.keys(input)) {
    const name = key.startsWith("$") ? key.slice(1) : key;
    if (!defs.has(name)) {
      issues.push({ code: "FIELD_UNKNOWN", field: `$${name}`, message: `The template has no value named $${name}` });
    }
  }

  for (const [name, def] of defs) {
    let raw = input[name] ?? input[`$${name}`];
    if (raw === undefined || raw === null) raw = def.rules.default;
    if (raw === undefined || raw === null) {
      if (def.rules.required !== false) {
        issues.push({ code: "FIELD_REQUIRED", field: def.key, message: `${def.rules.label ?? def.key} is required` });
      }
      continue;
    }
    const res = normalizeValue(def, raw);
    if (res.ok) values[name] = res.value;
    else issues.push({ code: "FIELD_INVALID", field: def.key, message: res.message });
  }

  return { values, issues };
}
