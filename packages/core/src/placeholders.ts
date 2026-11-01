import { parse as parseYaml } from "yaml";
import type { Issue } from "./errors.ts";

export const FieldTypes = [
  "text",
  "longtext",
  "number",
  "currency",
  "date",
  "signature",
  "initials",
  "checkbox",
  "choice",
] as const;
export type FieldType = (typeof FieldTypes)[number];

/** Types a sender may fill at creation, and types a signer may fill while signing. */
const SIGNER_ONLY: ReadonlySet<FieldType> = new Set(["signature", "initials"]);

export interface FieldRules {
  label?: string;
  required?: boolean;
  default?: unknown;
  minimum?: string | number;
  maximum?: string | number;
  max_length?: number;
  allowed_values?: unknown[];
  options?: string[];
}

export interface FieldDef {
  /** Full key as written in the template: "$fee" or "client.signature". */
  key: string;
  kind: "value" | "signer";
  /** Value name without "$" (values only). */
  name?: string;
  /** Signer key, e.g. "client" (signer fields only). */
  signer?: string;
  type: FieldType;
  /** Type parameter, e.g. "USD" for currency(USD). */
  param?: string;
  rules: FieldRules;
}

export interface Occurrence {
  key: string;
  /** Raw placeholder text including braces. */
  raw: string;
  start: number;
  end: number;
}

export interface ParsedTemplate {
  /** Markdown body without front matter. */
  body: string;
  fields: FieldDef[];
  occurrences: Occurrence[];
  issues: Issue[];
}

// {{$name:type}} / {{$name:type(param)}} / {{signer.field:type}}
// Value names may contain dots ("$client.name") for grouping.
const PLACEHOLDER =
  /(\\?)\{\{\s*(\$[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|[a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*:\s*([a-z]+)(?:\(([^)]*)\))?\s*\}\}/gi;
// Anything that looks like it was meant to be a placeholder.
const LOOSE = /(\\?)\{\{([^}]*)\}\}/g;

const RULE_KEYS = new Set([
  "label",
  "required",
  "default",
  "minimum",
  "maximum",
  "max_length",
  "allowed_values",
  "options",
]);

export function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontMatter: null, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontMatter: null, body: normalized };
  const after = normalized.indexOf("\n", end + 4);
  const body = after === -1 ? "" : normalized.slice(after + 1);
  return { frontMatter: normalized.slice(4, end + 1), body };
}

export function parseTemplate(source: string): ParsedTemplate {
  const issues: Issue[] = [];
  const { frontMatter, body } = splitFrontMatter(source);

  let ruleMap: Record<string, FieldRules> = {};
  if (frontMatter !== null) {
    try {
      const data = parseYaml(frontMatter) as unknown;
      if (data !== null && data !== undefined) {
        if (typeof data !== "object" || Array.isArray(data)) {
          issues.push({ code: "TEMPLATE_INVALID", message: "Front matter must be a YAML mapping" });
        } else {
          const fields = (data as Record<string, unknown>).fields;
          if (fields !== undefined) {
            if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
              issues.push({ code: "TEMPLATE_INVALID", message: "Front matter 'fields' must be a mapping" });
            } else {
              ruleMap = fields as Record<string, FieldRules>;
            }
          }
        }
      }
    } catch (err) {
      issues.push({ code: "TEMPLATE_INVALID", message: `Front matter is not valid YAML: ${(err as Error).message}` });
    }
  }

  const fields = new Map<string, FieldDef>();
  const occurrences: Occurrence[] = [];
  const matchedRanges = new Set<number>();

  for (const m of body.matchAll(PLACEHOLDER)) {
    const [raw, escape, key, typeName, param] = m as unknown as [string, string, string, string, string | undefined];
    const start = m.index!;
    matchedRanges.add(start);
    if (escape) continue;

    const type = typeName.toLowerCase() as FieldType;
    if (!FieldTypes.includes(type)) {
      issues.push({ code: "TEMPLATE_INVALID", field: key, message: `Unknown field type '${typeName}' for ${key}` });
      continue;
    }

    const isValue = key.startsWith("$");
    if (isValue && SIGNER_ONLY.has(type)) {
      issues.push({
        code: "TEMPLATE_INVALID",
        field: key,
        message: `${key} is a template value, but '${type}' fields can only be filled by a signer`,
      });
      continue;
    }
    if (type === "currency" && !/^[A-Z]{3}$/.test(param ?? "")) {
      issues.push({
        code: "TEMPLATE_INVALID",
        field: key,
        message: `${key} needs a currency code, for example currency(USD)`,
      });
      continue;
    }

    occurrences.push({ key, raw, start, end: start + raw.length });

    const existing = fields.get(key);
    if (existing) {
      if (existing.type !== type || (existing.param ?? null) !== (param ?? null)) {
        issues.push({
          code: "TEMPLATE_INVALID",
          field: key,
          message: `${key} is used with different types (${existing.type} and ${type})`,
        });
      }
      continue;
    }

    const def: FieldDef = isValue
      ? { key, kind: "value", name: key.slice(1), type, rules: {} }
      : { key, kind: "signer", signer: key.split(".")[0]!, type, rules: {} };
    if (param !== undefined) def.param = param;
    fields.set(key, def);
  }

  // Report malformed placeholders so authors are not surprised by literal braces.
  for (const m of body.matchAll(LOOSE)) {
    if (m[1] || matchedRanges.has(m.index!)) continue;
    issues.push({
      code: "TEMPLATE_INVALID",
      message: `Malformed placeholder '${m[0]}'. Use {{$name:type}} or {{signer.field:type}}, or write \\{{ for literal braces`,
    });
  }

  for (const [key, rules] of Object.entries(ruleMap)) {
    const def = fields.get(key);
    if (!def) {
      issues.push({ code: "FIELD_UNKNOWN", field: key, message: `Front matter defines ${key}, but the template does not use it` });
      continue;
    }
    if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
      issues.push({ code: "TEMPLATE_INVALID", field: key, message: `Rules for ${key} must be a mapping` });
      continue;
    }
    for (const rk of Object.keys(rules)) {
      if (!RULE_KEYS.has(rk)) {
        issues.push({ code: "TEMPLATE_INVALID", field: key, message: `Unknown rule '${rk}' for ${key}` });
      }
    }
    if (def.type === "choice" && rules.options !== undefined && !Array.isArray(rules.options)) {
      issues.push({ code: "TEMPLATE_INVALID", field: key, message: `options for ${key} must be a list` });
    }
    def.rules = rules;
  }

  for (const def of fields.values()) {
    if (def.type !== "choice") continue;
    // Inline options, e.g. {{$plan:choice(basic|pro)}}, unless front matter sets them.
    if (def.rules.options === undefined && def.param) {
      def.rules.options = def.param.split("|").map((o) => o.trim()).filter(Boolean);
    }
    if (!(Array.isArray(def.rules.options) && def.rules.options.length > 0)) {
      issues.push({
        code: "TEMPLATE_INVALID",
        field: def.key,
        message: `${def.key} is a choice field and needs options, for example choice(basic|pro)`,
      });
    }
  }

  return { body, fields: [...fields.values()], occurrences, issues };
}
