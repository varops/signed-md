import { type FieldDef, type FieldValue, normalizeValue, SignedError, transition } from "@signed-md/core";
import { enqueueJob, now } from "@signed-md/db";
import type { ElementContent } from "hast";
import type { Actor, Ctx } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { appendEvent } from "./events.ts";
import { activateNextGroup, type DocRow, loadDocument, loadSigners, lockDocument, type SignerRow } from "./documents.ts";
import { emitWebhook } from "./webhooks.ts";
import { type ContractFont, fontOf } from "./fonts.ts";

/** Short summary shown above the consent checkbox. */
export const CONSENT_TEXT =
  "You can review and sign this document electronically instead of on paper. Your electronic signature has the same legal effect as a handwritten one. You'll get a copy of the completed document by email, and you can download it. You can decline to sign at any time before you finish.";

export const DISCLOSURE_VERSION = "2026-11-02";

/**
 * Electronic record and signature disclosure. Covers what the US ESIGN Act asks consumers to be told:
 * the right to paper copies, how to withdraw consent, what the consent covers, how to update contact
 * details, and the hardware and software needed. The exact text each signer agreed to is stored in
 * their consent event, so the evidence shows what they saw.
 */
export function disclosureText(input: { account: string; contactName: string | null; contactEmail: string | null }): string {
  const contact = input.contactEmail ? `${input.contactName ?? input.account} at ${input.contactEmail}` : input.account;
  return `Electronic record and signature disclosure (version ${DISCLOSURE_VERSION})

${input.account} wants to send you this document and get your signature electronically, using Signed.md.

Agreeing to use electronic records and signatures
By selecting "I agree", you confirm that you can open and read this disclosure, and that you agree to receive and sign this document electronically. Your electronic signature has the same legal effect as a handwritten signature.

Paper copies
You can ask for a paper copy of this document at any time, free of charge, by contacting ${contact}.

Withdrawing your consent
You can withdraw your consent before you finish signing, by choosing "Decline to sign" or by contacting ${contact}. Withdrawing consent does not affect documents you already signed electronically.

What this consent covers
It covers this document only, and the notices about it, such as reminders and the completed copy.

Keeping a copy
When everyone has signed, you receive the completed document by email as a PDF. You can also download it from the signing page.

What you need
A device with a current web browser, an email address, and software that can open PDF files. If these change in a way that stops you from opening the document, contact ${contact}.

Updating your contact details
To change the email address used for this document, contact ${contact}.`;
}

async function disclosureFor(ctx: Ctx, doc: DocRow): Promise<string> {
  const account = await ctx.db.selectFrom("accounts").select("name").limit(1).executeTakeFirstOrThrow();
  const owner = doc.owner_user_id ? await ctx.db.selectFrom("users").select(["name", "email"]).where("id", "=", doc.owner_user_id).executeTakeFirst() : undefined;
  return disclosureText({ account: account.name, contactName: owner ? owner.name || owner.email : null, contactEmail: owner?.email ?? null });
}

export type SignatureValue = { kind: "drawn"; image: string } | { kind: "typed"; text: string };
export type SignerFieldValue = FieldValue | SignatureValue;

export interface RequestMeta {
  ip: string | null;
  user_agent: string | null;
}

const PNG_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_BYTES = 300_000;

function signerActor(s: SignerRow): Actor {
  return { kind: "signer", id: s.id, label: `${s.name} <${s.email}>` };
}

export function normalizeSignerValue(def: FieldDef, input: unknown): { ok: true; value: SignerFieldValue } | { ok: false; message: string } {
  if (def.type === "signature" || def.type === "initials") {
    const v = input as Partial<SignatureValue> | null;
    if (v && v.kind === "typed" && typeof v.text === "string") {
      const text = v.text.normalize("NFC").replace(/\s+/g, " ").trim();
      if (!text || text.length > 100) return { ok: false, message: `${def.rules.label ?? def.key}: type your ${def.type === "initials" ? "initials" : "name"}` };
      return { ok: true, value: { kind: "typed", text } };
    }
    if (v && v.kind === "drawn" && typeof v.image === "string" && v.image.startsWith(PNG_PREFIX)) {
      const bytes = Buffer.from(v.image.slice(PNG_PREFIX.length), "base64");
      const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPng || bytes.length > MAX_IMAGE_BYTES) return { ok: false, message: `${def.rules.label ?? def.key}: the drawn ${def.type} is not a valid image` };
      return { ok: true, value: { kind: "drawn", image: PNG_PREFIX + bytes.toString("base64") } };
    }
    return { ok: false, message: `${def.rules.label ?? def.key}: please ${def.type === "initials" ? "add your initials" : "sign"}` };
  }
  if (def.type === "checkbox" && def.rules.required !== false && input !== true) {
    return { ok: false, message: `${def.rules.label ?? def.key} must be checked` };
  }
  const r = normalizeValue(def, input);
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.message };
}

interface Session {
  doc: DocRow;
  signer: SignerRow;
}

async function findByToken(ctx: Ctx, token: string): Promise<Session | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const signer = await ctx.db.selectFrom("signers").selectAll().where("token_hash", "=", sha256(token)).executeTakeFirst();
  if (!signer) return null;
  const doc = await loadDocument(ctx.db, signer.document_id);
  return { doc, signer };
}

export type SignerPageState =
  | { state: "invalid" }
  | { state: "expired" | "revoked" | "declined"; title: string }
  | { state: "signed"; title: string; signer_name: string; document_status: string }
  | { state: "sign"; view: SignerView };

export interface SignerView {
  document_id: string;
  title: string;
  account_name: string;
  /** The team member who sent the document. */
  sender_name: string | null;
  signer: { key: string; name: string; email: string };
  /** True once the signer agreed to sign electronically (the "Let's start" step). */
  consented: boolean;
  font: ContractFont;
  /** Resolved Markdown with signer placeholders, plus everything needed to render it. */
  content: string;
  defs: FieldDef[];
  /** Values already completed by signers who signed before. */
  completed: Record<string, SignerFieldValue>;
  /** Signer key → name, to label other signers' fields. */
  names: Record<string, string>;
  fields: { key: string; label: string; type: string; required: boolean; options?: string[] }[];
  consent_text: string;
  /** Full electronic record and signature disclosure. */
  disclosure: string;
  progress: { signed: number; total: number };
  expires_at: string | null;
}

function isExpired(doc: DocRow): boolean {
  return doc.expires_at !== null && doc.expires_at < now();
}

/** Load the signing page for a token. Records the first view as evidence. */
export async function openSigningPage(ctx: Ctx, token: string, meta: RequestMeta): Promise<SignerPageState> {
  const s = await findByToken(ctx, token);
  if (!s) return { state: "invalid" };
  const { doc, signer } = s;
  if (doc.status === "revoked") return { state: "revoked", title: doc.title };
  if (doc.status === "declined") return { state: "declined", title: doc.title };
  if (doc.status === "expired" || (isExpired(doc) && !["signed", "finalized"].includes(doc.status))) return { state: "expired", title: doc.title };
  if (signer.status === "signed") return { state: "signed", title: doc.title, signer_name: signer.name, document_status: doc.status };
  if (!["sent", "partially_signed"].includes(doc.status)) return { state: "invalid" };

  if (signer.status === "notified") {
    await ctx.db.transaction().execute(async (trx) => {
      await lockDocument(ctx, trx, doc.id);
      const fresh = await trx.selectFrom("signers").select("status").where("id", "=", signer.id).executeTakeFirstOrThrow();
      if (fresh.status !== "notified") return;
      await trx.updateTable("signers").set({ status: "viewed", viewed_at: now() }).where("id", "=", signer.id).execute();
      await appendEvent(trx, doc.id, "signer.viewed", signerActor(signer), { signer: signer.key, ...meta });
    });
  }
  return { state: "sign", view: await buildSignerView(ctx, doc, signer) };
}

async function buildSignerView(ctx: Ctx, doc: DocRow, signer: SignerRow): Promise<SignerView> {
  const fieldRows = await ctx.db.selectFrom("fields").selectAll().where("document_id", "=", doc.id).orderBy("position").execute();
  const defs = fieldRows.map((f) => JSON.parse(f.definition) as FieldDef);
  const completed = new Map(fieldRows.filter((f) => f.value !== null && f.kind === "signer").map((f) => [f.key, JSON.parse(f.value!) as SignerFieldValue]));
  const signers = await loadSigners(ctx.db, doc.id);
  const names = new Map(signers.map((s) => [s.key, s.name]));
  const account = await ctx.db.selectFrom("accounts").select("name").executeTakeFirstOrThrow();

  return {
    document_id: doc.id,
    title: doc.title,
    account_name: account.name,
    sender_name: doc.owner_user_id
      ? await ctx.db.selectFrom("users").select(["name", "email"]).where("id", "=", doc.owner_user_id).executeTakeFirst().then((u) => (u ? u.name || u.email : null))
      : null,
    signer: { key: signer.key, name: signer.name, email: signer.email },
    consented: signer.consented_at !== null,
    font: fontOf(doc.font),
    content: doc.content,
    defs,
    completed: Object.fromEntries(completed),
    names: Object.fromEntries(names),
    fields: defs
      .filter((d) => d.kind === "signer" && d.signer === signer.key)
      .map((d) => ({
        key: d.key,
        label: d.rules.label ?? fieldLabel(d),
        type: d.type,
        required: d.rules.required !== false,
        ...(d.rules.options ? { options: d.rules.options.map(String) } : {}),
      })),
    consent_text: CONSENT_TEXT,
    disclosure: await disclosureFor(ctx, doc),
    progress: { signed: signers.filter((s) => s.status === "signed").length, total: signers.length },
    expires_at: doc.expires_at,
  };
}

export function fieldLabel(def: FieldDef): string {
  const name = def.key.split(".").pop()!.replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function renderCompletedValue(def: FieldDef, v: SignerFieldValue): ElementContent {
  if (typeof v === "object" && v !== null && "kind" in v) {
    if (v.kind === "drawn") {
      return { type: "element", tagName: "img", properties: { className: ["smd-signature"], src: v.image, alt: `${def.type} of ${def.signer}` }, children: [] };
    }
    return { type: "element", tagName: "span", properties: { className: ["smd-signature-typed"] }, children: [{ type: "text", value: v.text }] };
  }
  const text = def.type === "checkbox" ? (v ? "☑" : "☐") : String(v);
  return { type: "element", tagName: "span", properties: { className: ["smd-value"] }, children: [{ type: "text", value: text }] };
}

/**
 * The "Let's start" step: the signer agrees to use electronic records and signatures.
 * Recorded as evidence before they can complete any field.
 */
export async function recordConsent(ctx: Ctx, token: string, meta: RequestMeta): Promise<void> {
  const s = await findByToken(ctx, token);
  if (!s) throw new SignedError("PERMISSION_DENIED", "This signing link is not valid");
  // Read outside the transaction: SQLite has one connection, and the transaction holds it.
  const disclosure = await disclosureFor(ctx, s.doc);
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, s.doc.id);
    const signer = await trx.selectFrom("signers").selectAll().where("id", "=", s.signer.id).executeTakeFirstOrThrow();
    if (!["sent", "partially_signed"].includes(doc.status) || isExpired(doc)) throw new SignedError("INVALID_TRANSITION", "This document can no longer be signed");
    if (signer.consented_at || signer.status === "signed" || signer.status === "declined") return;
    await trx.updateTable("signers").set({ consented_at: now() }).where("id", "=", signer.id).execute();
    await appendEvent(trx, doc.id, "signer.consented", signerActor(signer), {
      signer: signer.key,
      disclosure_version: DISCLOSURE_VERSION,
      disclosure_sha256: sha256(disclosure),
      disclosure,
      ...meta,
    });
  });
}

/** Submit the signer's fields and signature. All-or-nothing. */
export async function submitSignature(
  ctx: Ctx,
  token: string,
  input: { consent: boolean; fields: Record<string, unknown> },
  meta: RequestMeta,
): Promise<{ document_status: string }> {
  const s = await findByToken(ctx, token);
  if (!s) throw new SignedError("PERMISSION_DENIED", "This signing link is not valid");
  const disclosure = await disclosureFor(ctx, s.doc);
  return ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, s.doc.id);
    const signer = await trx.selectFrom("signers").selectAll().where("id", "=", s.signer.id).executeTakeFirstOrThrow();
    if (!["sent", "partially_signed"].includes(doc.status) || isExpired(doc)) {
      throw new SignedError("INVALID_TRANSITION", "This document can no longer be signed");
    }
    if (signer.token_hash !== sha256(token)) throw new SignedError("PERMISSION_DENIED", "This signing link is no longer valid");
    if (signer.status !== "notified" && signer.status !== "viewed") throw new SignedError("INVALID_TRANSITION", "You have already completed this document");
    if (!signer.consented_at && !input.consent) {
      throw new SignedError("FIELD_REQUIRED", "You must agree to sign electronically", [{ code: "FIELD_REQUIRED", field: "consent", message: "Consent is required" }]);
    }

    const fieldRows = await trx.selectFrom("fields").selectAll().where("document_id", "=", doc.id).where("signer_key", "=", signer.key).orderBy("position").execute();
    const issues = [];
    const values: { id: string; key: string; type: string; value: SignerFieldValue }[] = [];
    for (const row of fieldRows) {
      const def = JSON.parse(row.definition) as FieldDef;
      const raw = input.fields[def.key];
      if (raw === undefined || raw === null || raw === "") {
        if (def.rules.required !== false) issues.push({ code: "FIELD_REQUIRED" as const, field: def.key, message: `${def.rules.label ?? fieldLabel(def)} is required` });
        continue;
      }
      const r = normalizeSignerValue(def, raw);
      if (!r.ok) issues.push({ code: "FIELD_INVALID" as const, field: def.key, message: r.message });
      else values.push({ id: row.id, key: def.key, type: def.type, value: r.value });
    }
    if (issues.length) throw new SignedError(issues[0]!.code, "Some fields need attention", issues);

    const t = now();
    for (const v of values) {
      await trx.updateTable("fields").set({ value: JSON.stringify(v.value), completed_at: t }).where("id", "=", v.id).execute();
    }
    await trx.updateTable("signers").set({ status: "signed", signed_at: t, consented_at: signer.consented_at ?? t }).where("id", "=", signer.id).execute();

    const actor = signerActor(signer);
    if (!signer.consented_at) {
      await appendEvent(trx, doc.id, "signer.consented", actor, { signer: signer.key, disclosure_version: DISCLOSURE_VERSION, disclosure_sha256: sha256(disclosure), disclosure, ...meta });
    }
    await appendEvent(trx, doc.id, "signer.signed", actor, {
      signer: signer.key,
      fields: values.map((v) => ({ key: v.key, type: v.type, value_sha256: sha256(JSON.stringify(v.value)) })),
      content_sha256: sha256(doc.content),
      revision: doc.revision,
      ...meta,
    });

    const signers = await loadSigners(trx, doc.id);
    const unsigned = signers.filter((x) => x.status !== "signed");

    if (unsigned.length === 0) {
      const status = transition(doc.status as never, "complete");
      await trx.updateTable("documents").set({ status, completed_at: t, updated_at: t }).where("id", "=", doc.id).execute();
      await appendEvent(trx, doc.id, "document.signed", { kind: "system", id: "system", label: "Signed.md" }, {});
      await emitWebhook(ctx, trx, { ...doc, status }, "document.signed", { completed_at: t });
      await enqueueJob(trx, "finalize", { document_id: doc.id }, { dedupeKey: `finalize:${doc.id}` });
      return { document_status: status };
    }

    const status = transition(doc.status as never, "sign");
    await trx.updateTable("documents").set({ status, updated_at: t }).where("id", "=", doc.id).execute();
    await activateNextGroup(ctx, trx, doc.id);

    if (unsigned.length === 1 && signers.length > 1) {
      const last = (await loadSigners(trx, doc.id)).find((x) => x.status !== "signed")!;
      const notified = last.status === "notified" || last.status === "viewed";
      await emitWebhook(ctx, trx, { ...doc, status }, "document.awaiting_last_signer", {
        signer: { key: last.key, name: last.name, email: last.email, notified },
      });
      // If they already had their link, nudge them. A newly activated signer already got a signing request.
      if (notified && last.notified_at && last.notified_at < t) {
        await enqueueJob(trx, "email", { kind: "last_signer", document_id: doc.id, signer_id: last.id });
      }
    }
    return { document_status: status };
  });
}

export async function declineDocument(ctx: Ctx, token: string, reason: string | undefined, meta: RequestMeta): Promise<void> {
  const s = await findByToken(ctx, token);
  if (!s) throw new SignedError("PERMISSION_DENIED", "This signing link is not valid");
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, s.doc.id);
    const signer = await trx.selectFrom("signers").selectAll().where("id", "=", s.signer.id).executeTakeFirstOrThrow();
    if (signer.status === "signed") throw new SignedError("INVALID_TRANSITION", "You have already signed this document");
    const status = transition(doc.status as never, "decline");
    const t = now();
    const why = reason?.trim().slice(0, 1000) || null;
    await trx.updateTable("documents").set({ status, updated_at: t }).where("id", "=", doc.id).execute();
    await trx.updateTable("signers").set({ status: "declined", declined_at: t, decline_reason: why }).where("id", "=", signer.id).execute();
    await trx.updateTable("signers").set({ token_hash: null }).where("document_id", "=", doc.id).where("id", "!=", signer.id).execute();
    await appendEvent(trx, doc.id, "signer.declined", signerActor(signer), { signer: signer.key, reason: why, ...meta });
    await emitWebhook(ctx, trx, { ...doc, status }, "document.declined", {
      signer: { key: signer.key, name: signer.name, email: signer.email },
      reason: why,
    });
    await enqueueJob(trx, "email", { kind: "declined", document_id: doc.id, signer_id: signer.id });
  });
}

/** Expire documents whose deadline passed. Run periodically by the worker. */
export async function expireDocuments(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .selectFrom("documents")
    .select("id")
    .where("status", "in", ["sent", "partially_signed"])
    .where("expires_at", "<", now())
    .execute();
  for (const { id } of due) {
    await ctx.db.transaction().execute(async (trx) => {
      const doc = await lockDocument(ctx, trx, id);
      if (!["sent", "partially_signed"].includes(doc.status)) return;
      const status = transition(doc.status as never, "expire");
      await trx.updateTable("documents").set({ status, updated_at: now() }).where("id", "=", id).execute();
      await trx.updateTable("signers").set({ token_hash: null }).where("document_id", "=", id).execute();
      await appendEvent(trx, id, "document.expired", { kind: "system", id: "system", label: "Signed.md" }, { expires_at: doc.expires_at });
      await enqueueJob(trx, "email", { kind: "expired", document_id: id });
    });
  }
  return due.length;
}
