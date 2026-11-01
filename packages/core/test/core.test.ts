import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeRevision,
  parseTemplate,
  prepareDocument,
  renderHtml,
  SignedError,
  signingGroups,
  transition,
  validateValues,
} from "../src/index.ts";

const TEMPLATE = `---
fields:
  $fee:
    label: Monthly fee
    minimum: "100.00"
  $notice_days:
    allowed_values: [30, 60, 90]
    default: 30
---

# Service agreement

Client: {{$client_name:text}}

Monthly fee: {{$fee:currency(USD)}}

Notice period: {{$notice_days:number}} days. Again: {{$notice_days:number}}.

Plan: {{$plan:choice(basic|pro)}}

Start date: {{client.start_date:date}}

Client signature: {{client.signature:signature}}

Provider signature: {{provider.signature:signature}}

Literal: \\{{not a field}}
`;

const SIGNERS = [
  { key: "client", name: "Jane Doe", email: "Jane@Acme.example" },
  { key: "provider", name: "Sam Lee", email: "sam@example.com", order: 2 },
];

describe("parseTemplate", () => {
  it("parses values, signer fields, front matter and escapes", () => {
    const t = parseTemplate(TEMPLATE);
    expect(t.issues).toEqual([]);
    const keys = t.fields.map((f) => f.key);
    expect(keys).toEqual([
      "$client_name",
      "$fee",
      "$notice_days",
      "$plan",
      "client.start_date",
      "client.signature",
      "provider.signature",
    ]);
    const fee = t.fields.find((f) => f.key === "$fee")!;
    expect(fee).toMatchObject({ kind: "value", name: "fee", type: "currency", param: "USD" });
    expect(fee.rules.label).toBe("Monthly fee");
    expect(t.fields.find((f) => f.key === "$plan")!.rules.options).toEqual(["basic", "pro"]);
    expect(t.fields.find((f) => f.key === "client.signature")).toMatchObject({ kind: "signer", signer: "client" });
    expect(t.occurrences.filter((o) => o.key === "$notice_days")).toHaveLength(2);
  });

  it("works without front matter", () => {
    const t = parseTemplate("Hello {{$name:text}}, sign here: {{client.signature:signature}}");
    expect(t.issues).toEqual([]);
    expect(t.fields).toHaveLength(2);
  });

  it("reports bad templates", () => {
    const codes = (src: string) => parseTemplate(src).issues.map((i) => i.code);
    expect(codes("{{$x:banana}}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("{{$sig:signature}}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("{{$fee:currency}}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("{{$a:text}} {{$a:number}}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("{{ oops }}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("{{$c:choice}}")).toEqual(["TEMPLATE_INVALID"]);
    expect(codes("---\nfields:\n  $ghost: {}\n---\n{{$a:text}}")).toEqual(["FIELD_UNKNOWN"]);
    expect(codes("---\nfields: [\n---\nx")).toEqual(["TEMPLATE_INVALID"]);
  });
});

describe("validateValues", () => {
  const { fields } = parseTemplate(TEMPLATE);

  it("normalises values and applies defaults", () => {
    const r = validateValues(fields, { client_name: " Acme Ltd ", fee: 1000, plan: "pro" });
    expect(r.issues).toEqual([]);
    expect(r.values).toEqual({ client_name: "Acme Ltd", fee: "1000.00", notice_days: "30", plan: "pro" });
  });

  it("enforces constraints without floats", () => {
    const r = validateValues(fields, { client_name: "A", fee: "99.99", notice_days: 45, plan: "gold", extra: 1 });
    const byField = Object.fromEntries(r.issues.map((i) => [i.field, i.code]));
    expect(byField).toEqual({
      $extra: "FIELD_UNKNOWN",
      $fee: "FIELD_INVALID",
      $notice_days: "FIELD_INVALID",
      $plan: "FIELD_INVALID",
    });
    expect(validateValues(fields, { client_name: "A", fee: 1000.5, plan: "pro" }).issues[0]?.code).toBe("FIELD_INVALID");
    expect(validateValues(fields, { client_name: "A", fee: "10.001", plan: "pro" }).issues[0]?.code).toBe("FIELD_INVALID");
  });

  it("reports missing required values", () => {
    const r = validateValues(fields, {});
    expect(r.issues.filter((i) => i.code === "FIELD_REQUIRED").map((i) => i.field)).toEqual(["$client_name", "$fee", "$plan"]);
  });

  it("validates dates", () => {
    const f = parseTemplate("{{$d:date}}").fields;
    expect(validateValues(f, { d: "2026-02-29" }).issues).toHaveLength(1);
    expect(validateValues(f, { d: "2028-02-29" }).issues).toHaveLength(0);
  });
});

describe("prepareDocument", () => {
  const values = { client_name: "Acme *Ltd* <script>", fee: "1000", plan: "basic" };

  it("resolves values, keeps signer fields, and is valid", () => {
    const d = prepareDocument({ source: TEMPLATE, values, signers: SIGNERS });
    expect(d.issues).toEqual([]);
    expect(d.valid).toBe(true);
    expect(d.content).toContain("$1,000.00");
    expect(d.content).toContain("{{client.signature:signature}}");
    expect(d.content).not.toContain("{{$");
    expect(d.signers[0]!.email).toBe("jane@acme.example");
    expect(d.revision).toMatch(/^rev_[0-9a-f]{32}$/);
  });

  it("reports signer problems", () => {
    const d = prepareDocument({
      source: TEMPLATE,
      values,
      signers: [
        { key: "client", name: "Jane", email: "jane@acme.example" },
        { key: "client", name: "Dup", email: "x@y.z" },
        { key: "witness", name: "W", email: "bad", order: 0 },
      ],
    });
    const codes = d.issues.map((i) => `${i.code}:${i.field}`);
    expect(codes).toContain("SIGNER_INVALID:signers[1].key");
    expect(codes).toContain("SIGNER_INVALID:signers[2].email");
    expect(codes).toContain("SIGNER_INVALID:signers[2].order");
    expect(codes).toContain("SIGNER_MISSING:provider.signature");
    expect(d.valid).toBe(false);
  });

  it("changes revision on any edit, and only then", () => {
    const a = prepareDocument({ source: TEMPLATE, values, signers: SIGNERS }).revision;
    const b = prepareDocument({ source: TEMPLATE, values, signers: [...SIGNERS].reverse() }).revision;
    const c = prepareDocument({ source: TEMPLATE, values: { ...values, fee: "1200" }, signers: SIGNERS }).revision;
    const e = prepareDocument({ source: TEMPLATE, values, signers: [SIGNERS[0], { ...SIGNERS[1]!, order: 1 }] }).revision;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(e);
  });
});

describe("renderHtml", () => {
  it("escapes injected values and drops raw HTML", () => {
    const d = prepareDocument({
      source: "Client: {{$n:text}}\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\nSign: {{client.signature:signature}}",
      values: { n: "**bold** <img src=x onerror=alert(1)>" },
      signers: [{ key: "client", name: "J", email: "j@x.io" }],
    });
    const html = renderHtml(d.content, { fields: d.fields });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("**bold**");
    expect(html).toContain('data-field="client.signature"');
  });

  it("renders literal braces from escapes", () => {
    expect(renderHtml("Use \\{{braces}} here")).toContain("{{braces}}");
  });
});

describe("signing order and state", () => {
  it("groups signers by order", () => {
    const groups = signingGroups([
      { key: "p", name: "P", email: "p@x.io", order: 2 },
      { key: "c1", name: "C1", email: "c1@x.io", order: 1 },
      { key: "c2", name: "C2", email: "c2@x.io", order: 1 },
    ]);
    expect(groups.map((g) => g.map((s) => s.key))).toEqual([["c1", "c2"], ["p"]]);
  });

  it("enforces transitions", () => {
    expect(transition("draft", "send")).toBe("sent");
    expect(transition("partially_signed", "complete")).toBe("signed");
    expect(transition("signed", "finalize")).toBe("finalized");
    expect(() => transition("sent", "send")).toThrow(SignedError);
    expect(() => transition("draft", "revoke")).toThrowError(/cannot be revoked/);
    expect(() => transition("finalized", "decline")).toThrow(SignedError);
  });
});

describe("canonicalJson", () => {
  it("sorts keys and is stable", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
    expect(computeRevision({ content: "x", values: {}, signers: [] })).toBe(computeRevision({ content: "x", values: {}, signers: [] }));
  });
});

describe("renderHtml tables", () => {
  it("renders GFM tables with fields inside", () => {
    const html = renderHtml("| Item | Fee |\n|---|---|\n| Retainer | 100 |\n\nSign: {{c.signature:signature}}");
    expect(html).toContain("<table>");
    expect(html).toContain('data-field="c.signature"');
  });
});
