import {
  type FieldDef,
  type FieldValue,
  type Issue,
  prepareDocument,
  type PreparedDocument,
  renderHtml,
  SignedError,
  signingGroups,
  transition,
  formatValue,
  type DocumentStatus,
  mixedOrderIssue,
} from "@signed-md/core";
import { type Database, type DocumentTable, enqueueJob, newId, now, type SignerTable } from "@signed-md/db";
import type { Kysely, Selectable, Transaction } from "kysely";
import { type Actor, actorRef, type Ctx } from "../context.ts";
import { randomToken, seal, sha256 } from "../crypto.ts";
import { getAccount } from "./accounts.ts";
import { can, requireManageDocument, requirePermission, requireReadDocument, userIdOf } from "./permissions.ts";
import { userById } from "./team.ts";
import { CONTRACT_FONT_NAMES, type ContractFont, fontOf, isContractFont } from "./fonts.ts";
import { checkMessageVariables } from "./messagevars.ts";
import { appendEvent } from "./events.ts";
import { resolveVersionForDocument } from "./templates.ts";
import { assertWebhookUrlShape } from "./webhooks.ts";
import { folderFor, folderNames } from "./folders.ts";
import { countSent, requireUnderLimit } from "./usage.ts";

export type DocRow = Selectable<DocumentTable>;
export type SignerRow = Selectable<SignerTable>;

export interface SignerInput {
  key: string;
  name: string;
  email: string;
  order?: number;
}

export interface CreateDocumentInput {
  template_id?: string;
  template_version?: number;
  content?: string;
  title?: string;
  values?: Record<string, unknown>;
  signers: SignerInput[];
  expires_in_days?: number;
  timezone?: string;
  locale?: string;
  webhook_url?: string | null;
  metadata?: Record<string, unknown>;
  /** "serif" or "sans-serif". Defaults to the account's contract font. */
  font?: string;
  auto_send?: boolean;
  approved_by?: string;
  /** A document folder to file it in. Organises only: not part of the revision. */
  folder_id?: string | null;
}

export interface UpdateDocumentInput {
  title?: string;
  content?: string;
  values?: Record<string, unknown | null>;
  signers?: SignerInput[];
  remove_signers?: string[];
  expires_in_days?: number;
  timezone?: string;
  locale?: string;
  webhook_url?: string | null;
  metadata?: Record<string, unknown>;
  font?: string;
}

// ---------------------------------------------------------------------------
// Helpers

export async function lockDocument(ctx: Ctx, trx: Transaction<Database>, id: string): Promise<DocRow> {
  let q = trx.selectFrom("documents").selectAll().where("id", "=", id);
  // SQLite serialises write transactions; PostgreSQL needs an explicit row lock.
  if (ctx.dialect === "postgres") q = q.forUpdate();
  const doc = await q.executeTakeFirst();
  if (!doc) throw new SignedError("DOCUMENT_NOT_FOUND", `Document ${id} does not exist`);
  return doc;
}

export async function loadDocument(db: Kysely<Database>, id: string): Promise<DocRow> {
  const doc = await db.selectFrom("documents").selectAll().where("id", "=", id).executeTakeFirst();
  if (!doc) throw new SignedError("DOCUMENT_NOT_FOUND", `Document ${id} does not exist`);
  return doc;
}

export async function loadSigners(db: Kysely<Database>, documentId: string): Promise<SignerRow[]> {
  return db.selectFrom("signers").selectAll().where("document_id", "=", documentId).orderBy("signing_order").orderBy("key").execute();
}

function signerInputs(rows: SignerRow[]): SignerInput[] {
  return rows.map((s) => ({ key: s.key, name: s.name, email: s.email, order: Number(s.signing_order) }));
}

function settingsOf(doc: Pick<DocRow, "title" | "expires_in_days" | "timezone" | "locale" | "font">) {
  // The font changes what signers see, so it is part of the revision a person approves.
  return { title: doc.title, expires_in_days: Number(doc.expires_in_days), timezone: doc.timezone, locale: doc.locale, font: doc.font };
}

/** Re-run parsing and validation for a stored draft. Pure computation over stored inputs. */
export function prepareFrom(doc: DocRow, signers: SignerInput[]): PreparedDocument {
  return prepareDocument({
    source: doc.source,
    values: JSON.parse(doc.values_json) as Record<string, unknown>,
    signers,
    format: { locale: doc.locale },
    settings: settingsOf(doc),
  });
}

function checkSettings(input: { timezone?: string; locale?: string; expires_in_days?: number; webhook_url?: string | null; font?: string }, ctx: Ctx): void {
  if (input.font !== undefined && !isContractFont(input.font)) {
    throw new SignedError("INVALID_REQUEST", `font must be one of: ${CONTRACT_FONT_NAMES.join(", ")}`, [{ code: "INVALID_REQUEST", field: "font", message: "Unknown font" }]);
  }
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new SignedError("INVALID_REQUEST", `Unknown timezone '${input.timezone}'`, [{ code: "INVALID_REQUEST", field: "timezone", message: "Unknown timezone" }]);
    }
  }
  if (input.locale !== undefined) {
    try {
      new Intl.NumberFormat(input.locale);
    } catch {
      throw new SignedError("INVALID_REQUEST", `Unknown locale '${input.locale}'`, [{ code: "INVALID_REQUEST", field: "locale", message: "Unknown locale" }]);
    }
  }
  if (input.expires_in_days !== undefined && (!Number.isInteger(input.expires_in_days) || input.expires_in_days < 1 || input.expires_in_days > 365)) {
    throw new SignedError("INVALID_REQUEST", "expires_in_days must be between 1 and 365", [{ code: "INVALID_REQUEST", field: "expires_in_days", message: "Out of range" }]);
  }
  if (input.webhook_url) assertWebhookUrlShape(ctx, input.webhook_url);
}

function checkSignerShape(signers: SignerInput[]): void {
  const seen = new Set<string>();
  for (const [i, s] of signers.entries()) {
    if (seen.has(s.key)) {
      throw new SignedError("SIGNER_INVALID", `Signer key '${s.key}' is used more than once`, [
        { code: "SIGNER_INVALID", field: `signers[${i}].key`, message: "Duplicate key" },
      ]);
    }
    seen.add(s.key);
  }
}

/** Order 0 (any order) is for every signer or none. */
function checkSigningOrder(signers: SignerInput[]): void {
  const issue = mixedOrderIssue(signers);
  if (issue) throw new SignedError("SIGNER_INVALID", issue.message, [issue]);
}

function titleFrom(source: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  return (m?.[1] ?? fallback).replace(/\{\{[^}]*\}\}/g, "").trim().slice(0, 200) || fallback;
}

async function writeSigners(trx: Transaction<Database>, documentId: string, signers: SignerInput[]): Promise<void> {
  // Drafts only: signer rows have no history yet, so they can be replaced. (Signed.md never deletes after sending.)
  await trx.deleteFrom("signers").where("document_id", "=", documentId).execute();
  for (const s of signers) {
    await trx
      .insertInto("signers")
      .values({
        id: newId("sgn"),
        document_id: documentId,
        key: s.key,
        name: s.name.trim(),
        email: s.email.trim().toLowerCase(),
        signing_order: s.order ?? 1,
        token_hash: null,
        status: "pending",
        decline_reason: null,
        notified_at: null,
        viewed_at: null,
        consented_at: null,
        signed_at: null,
        declined_at: null,
      })
      .execute();
  }
}

// ---------------------------------------------------------------------------
// Create / update

export async function createDocument(ctx: Ctx, actor: Actor, input: CreateDocumentInput): Promise<DocumentView> {
  requirePermission(actor, "documents.create");
  await requireUnderLimit(ctx);
  const account = await getAccount(ctx);
  // The person who creates a document owns it and is its sender.
  const ownerId =
    userIdOf(actor) ??
    (await ctx.db.selectFrom("users").select("id").where("role", "=", "owner").where("status", "=", "active").orderBy("created_at").limit(1).executeTakeFirst())?.id ??
    null;
  const hasTemplate = input.template_id !== undefined;
  const hasContent = input.content !== undefined;
  if (hasTemplate === hasContent) {
    throw new SignedError("INVALID_REQUEST", "Provide exactly one of template_id or content");
  }
  checkSettings(input, ctx);
  checkSignerShape(input.signers);
  checkSigningOrder(input.signers);

  let source: string;
  let templateVersionId: string | null = null;
  let defaultTitle = "Untitled agreement";
  if (hasTemplate) {
    const v = await resolveVersionForDocument(ctx, input.template_id!, input.template_version);
    source = v.source;
    templateVersionId = v.id;
    defaultTitle = v.template.name;
  } else {
    if (account.config.inline_documents === "disabled") {
      throw new SignedError("INLINE_DISABLED", "Inline documents are disabled for this account. Use an approved template.");
    }
    source = input.content!;
    if (source.length > 500_000) throw new SignedError("INVALID_REQUEST", "Content is too large (max 500 KB)");
    defaultTitle = titleFrom(source, defaultTitle);
  }

  const id = newId("doc");
  const t = now();
  const base: DocRow = {
    id,
    account_id: account.id,
    template_version_id: templateVersionId,
    source_kind: hasTemplate ? "template" : "inline",
    source,
    values_json: JSON.stringify(input.values ?? {}),
    content: "",
    revision: "",
    status: "draft",
    title: (input.title?.trim() || defaultTitle).slice(0, 200),
    timezone: input.timezone ?? account.config.timezone,
    locale: input.locale ?? account.config.locale,
    expires_in_days: input.expires_in_days ?? account.config.default_expiry_days,
    metadata: JSON.stringify(input.metadata ?? {}),
    webhook_url: input.webhook_url ?? null,
    owner_user_id: ownerId,
    // Saved on the document, so a later change to the account default doesn't change it.
    font: input.font ?? account.config.branding.contract_font,
    signer_message: null,
    created_by: actorRef(actor),
    approved_revision: null,
    approved_by: null,
    inline_approved_by: null,
    inline_approved_at: null,
    inline_approved_revision: null,
    created_at: t,
    updated_at: t,
    sent_at: null,
    expires_at: null,
    completed_at: null,
    finalized_at: null,
    revoked_at: null,
    revoke_reason: null,
    archived_at: null,
    folder_id: await folderFor(ctx, "document", input.folder_id),
  };
  const prepared = prepareFrom(base, input.signers);
  base.content = prepared.content;
  base.revision = prepared.revision;

  await ctx.db.transaction().execute(async (trx) => {
    await trx.insertInto("documents").values(base).execute();
    await writeSigners(trx, id, input.signers);
    await appendEvent(trx, id, "document.created", actor, {
      source: base.source_kind,
      template_version_id: templateVersionId,
      revision: prepared.revision,
    });
  });

  if (input.auto_send) {
    if (!prepared.valid) {
      throw new SignedError(prepared.issues[0]!.code, "Document was created as a draft but cannot be auto-sent because it is not valid", prepared.issues);
    }
    return sendDocument(ctx, actor, id, {
      approved_revision: prepared.revision,
      approved_by: input.approved_by ?? `auto_send by ${actor.label}`,
    });
  }
  return getDocument(ctx, actor, id);
}

export async function updateDocument(ctx: Ctx, actor: Actor, id: string, input: UpdateDocumentInput): Promise<DocumentView> {
  checkSettings(input, ctx);
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    if (doc.status !== "draft") throw new SignedError("DOCUMENT_NOT_DRAFT", "Only drafts can be edited. Revoke and create a new document instead.");
    if (input.content !== undefined && doc.source_kind !== "inline") {
      throw new SignedError("INVALID_REQUEST", "content can only be changed on inline documents. Template documents follow their template.");
    }

    const values = JSON.parse(doc.values_json) as Record<string, unknown>;
    for (const [k, v] of Object.entries(input.values ?? {})) {
      if (v === null) delete values[k];
      else values[k] = v;
    }

    let signers = signerInputs(await loadSigners(trx, id));
    if (input.signers) {
      checkSignerShape(input.signers);
      for (const s of input.signers) {
        const i = signers.findIndex((x) => x.key === s.key);
        if (i >= 0) signers[i] = s;
        else signers.push(s);
      }
    }
    if (input.remove_signers) signers = signers.filter((s) => !input.remove_signers!.includes(s.key));
    checkSigningOrder(signers);

    const next: DocRow = {
      ...doc,
      source: input.content ?? doc.source,
      values_json: JSON.stringify(values),
      title: input.title?.trim() ? input.title.trim().slice(0, 200) : doc.title,
      expires_in_days: input.expires_in_days ?? doc.expires_in_days,
      timezone: input.timezone ?? doc.timezone,
      locale: input.locale ?? doc.locale,
      font: input.font ?? doc.font,
      webhook_url: input.webhook_url === undefined ? doc.webhook_url : input.webhook_url,
      metadata: input.metadata ? JSON.stringify(input.metadata) : doc.metadata,
      updated_at: now(),
    };
    const prepared = prepareFrom(next, signers);
    next.content = prepared.content;
    next.revision = prepared.revision;
    const { id: _id, ...rest } = next;
    await trx.updateTable("documents").set(rest).where("id", "=", id).execute();
    await writeSigners(trx, id, signers);
    if (prepared.revision !== doc.revision) {
      await appendEvent(trx, id, "document.updated", actor, { revision: prepared.revision, previous_revision: doc.revision });
    }
  });
  return getDocument(ctx, actor, id);
}

// ---------------------------------------------------------------------------
// Validate / preview

export interface ValidationResult {
  valid: boolean;
  revision: string;
  errors: Issue[];
  warnings: Issue[];
}

function warningsFor(ctx: { inlineSetting: string }, doc: DocRow): Issue[] {
  const w: Issue[] = [];
  if (doc.source_kind === "inline") {
    w.push({ code: "INVALID_REQUEST", message: "Inline document: no approved template protects this legal language." });
    if (ctx.inlineSetting === "needs_approval" && doc.inline_approved_revision !== doc.revision) {
      w.push({ code: "DOCUMENT_NOT_APPROVED", message: "This account requires a person to approve inline documents in the web UI before sending." });
    }
  }
  return w;
}

export async function validateDocument(ctx: Ctx, actor: Actor, id: string): Promise<ValidationResult> {
  const doc = await loadDocument(ctx.db, id);
  requireReadDocument(actor, doc);
  const account = await getAccount(ctx);
  const prepared = prepareFrom(doc, signerInputs(await loadSigners(ctx.db, id)));
  return { valid: prepared.valid, revision: prepared.revision, errors: prepared.issues, warnings: warningsFor({ inlineSetting: account.config.inline_documents }, doc) };
}

export interface PreviewResult extends ValidationResult {
  document_id: string;
  title: string;
  status: string;
  markdown: string;
  html: string;
  values: { key: string; label: string; type: string; value: FieldValue | null; display: string | null }[];
  signer_fields: { signer: string; fields: { key: string; label: string; type: string; required: boolean }[] }[];
  signing_order: { order: number; signers: { key: string; name: string; email: string }[] }[];
  template: { id: string; version: number } | null;
  source: "template" | "inline";
  font: ContractFont;
}

export async function previewDocument(ctx: Ctx, actor: Actor, id: string): Promise<PreviewResult> {
  const doc = await loadDocument(ctx.db, id);
  requireReadDocument(actor, doc);
  const account = await getAccount(ctx);
  const signerRows = await loadSigners(ctx.db, id);
  const prepared = prepareFrom(doc, signerInputs(signerRows));
  const fields = prepared.fields;

  const values = fields
    .filter((f) => f.kind === "value")
    .map((f) => {
      const v = prepared.values[f.name!];
      return {
        key: f.key,
        label: f.rules.label ?? f.name!,
        type: f.type,
        value: v ?? null,
        display: v === undefined ? null : formatValue(f, v, { locale: doc.locale }),
      };
    });

  const bySigner = new Map<string, FieldDef[]>();
  for (const f of fields) if (f.kind === "signer") bySigner.set(f.signer!, [...(bySigner.get(f.signer!) ?? []), f]);

  let template: PreviewResult["template"] = null;
  if (doc.template_version_id) {
    const tv = await ctx.db.selectFrom("template_versions").select(["template_id", "version"]).where("id", "=", doc.template_version_id).executeTakeFirstOrThrow();
    template = { id: tv.template_id, version: Number(tv.version) };
  }

  return {
    document_id: doc.id,
    title: doc.title,
    status: doc.status,
    valid: prepared.valid,
    revision: prepared.revision,
    errors: prepared.issues,
    warnings: warningsFor({ inlineSetting: account.config.inline_documents }, doc),
    markdown: prepared.content,
    html: renderHtml(prepared.content, {
      fields,
      renderField: (def) => {
        const who = prepared.signers.find((x) => x.key === def.signer)?.name ?? def.signer!;
        const label = def.rules.label ?? def.key.split(".").pop()!.replace(/_/g, " ");
        return {
          type: "element",
          tagName: "span",
          properties: { className: ["smd-field", `smd-field-${def.type}`], dataField: def.key },
          children: [{ type: "text", value: `${label.charAt(0).toUpperCase()}${label.slice(1)} – ${who}` }],
        };
      },
    }),
    values,
    signer_fields: [...bySigner.entries()].map(([signer, fs]) => ({
      signer,
      fields: fs.map((f) => ({ key: f.key, label: f.rules.label ?? f.key, type: f.type, required: f.rules.required !== false })),
    })),
    signing_order: signingGroups(prepared.signers).map((g) => ({
      order: g[0]!.order,
      signers: g.map((s) => ({ key: s.key, name: s.name, email: s.email })),
    })),
    template,
    source: doc.source_kind,
    font: fontOf(doc.font),
  };
}

// ---------------------------------------------------------------------------
// Send

export async function sendDocument(
  ctx: Ctx,
  actor: Actor,
  id: string,
  input: { approved_revision: string; approved_by?: string; message?: string },
): Promise<DocumentView> {
  const account = await getAccount(ctx);
  if (input.message !== undefined && input.message.length > 2000) {
    throw new SignedError("INVALID_REQUEST", "The message to signers must be at most 2000 characters", [{ code: "INVALID_REQUEST", field: "message", message: "Too long" }]);
  }
  if (input.message !== undefined) checkMessageVariables(input.message);
  const message = (input.message ?? account.config.branding.email_message).trim() || null;
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    if (doc.status !== "draft") throw new SignedError("DOCUMENT_ALREADY_SENT", "This document has already been sent");
    // Checked again here: drafts made before the limit was reached can't be sent past it.
    await requireUnderLimit(ctx, trx);
    const signerRows = await loadSigners(trx, id);
    const prepared = prepareFrom(doc, signerInputs(signerRows));
    if (!prepared.valid) throw new SignedError(prepared.issues[0]!.code, "The document is not valid. Fix the errors and preview again.", prepared.issues);
    if (prepared.revision !== input.approved_revision) {
      throw new SignedError("REVISION_MISMATCH", `The draft changed since it was previewed. Current revision is ${prepared.revision}. Preview again and get approval for the new revision.`);
    }
    if (doc.source_kind === "inline") {
      if (account.config.inline_documents === "disabled") throw new SignedError("INLINE_DISABLED", "Inline documents are disabled for this account");
      if (account.config.inline_documents === "needs_approval" && doc.inline_approved_revision !== prepared.revision) {
        throw new SignedError("DOCUMENT_NOT_APPROVED", "A person must approve this inline document in the Signed.md web UI before it can be sent.");
      }
    }

    const t = now();
    const status = transition("draft", "send");
    await trx
      .updateTable("documents")
      .set({
        status,
        content: prepared.content,
        revision: prepared.revision,
        sent_at: t,
        updated_at: t,
        expires_at: new Date(Date.now() + Number(doc.expires_in_days) * 86400_000).toISOString(),
        approved_revision: input.approved_revision,
        approved_by: input.approved_by?.slice(0, 500) ?? actor.label,
        signer_message: message,
      })
      .where("id", "=", id)
      .execute();
    await countSent(trx);

    // Freeze the field schema for this document.
    for (const [position, f] of prepared.fields.entries()) {
      await trx
        .insertInto("fields")
        .values({
          id: newId("fld"),
          document_id: id,
          key: f.key,
          kind: f.kind,
          type: f.type,
          signer_key: f.signer ?? null,
          position,
          definition: JSON.stringify(f),
          value: f.kind === "value" ? JSON.stringify(prepared.values[f.name!] ?? null) : null,
          completed_at: f.kind === "value" ? t : null,
        })
        .execute();
    }

    await appendEvent(trx, id, "document.approved", actor, {
      revision: prepared.revision,
      approved_by: input.approved_by ?? actor.label,
      approved_by_verified: false,
    });
    await appendEvent(trx, id, "document.sent", actor, {
      revision: prepared.revision,
      message_sha256: message ? sha256(message) : null,
      content_sha256: sha256(prepared.content),
      signers: prepared.signers.map((s) => ({ key: s.key, name: s.name, email: s.email, order: s.order })),
    });
    await activateNextGroup(ctx, trx, id);
  });
  return getDocument(ctx, actor, id);
}

/**
 * Notify the next signing group if every earlier group has signed.
 * Issues fresh signing tokens and queues emails. Returns the keys notified.
 */
export async function activateNextGroup(ctx: Ctx, trx: Transaction<Database>, documentId: string): Promise<string[]> {
  const signers = await loadSigners(trx, documentId);
  const unsigned = signers.filter((s) => s.status !== "signed");
  if (unsigned.length === 0) return [];
  const nextOrder = Math.min(...unsigned.map((s) => Number(s.signing_order)));
  const group = unsigned.filter((s) => Number(s.signing_order) === nextOrder && s.status === "pending");
  const notified: string[] = [];
  for (const s of group) {
    await issueToken(ctx, trx, documentId, s, "signing_request");
    notified.push(s.key);
  }
  return notified;
}

/** Create a new signing token for a signer (replacing any old one) and queue the email that carries it. */
export async function issueToken(
  ctx: Ctx,
  trx: Transaction<Database>,
  documentId: string,
  signer: SignerRow,
  emailKind: "signing_request" | "reminder" | "last_signer",
): Promise<void> {
  const token = randomToken(32);
  const t = now();
  await trx
    .updateTable("signers")
    .set({ token_hash: sha256(token), status: signer.status === "pending" ? "notified" : signer.status, notified_at: signer.notified_at ?? t })
    .where("id", "=", signer.id)
    .execute();
  await appendEvent(trx, documentId, "signer.notified", { kind: "system", id: "system", label: "Signed.md" }, {
    signer: signer.key,
    email: signer.email,
    kind: emailKind,
  });
  await enqueueJob(trx, "email", {
    kind: emailKind,
    document_id: documentId,
    signer_id: signer.id,
    // The raw token only ever exists sealed in the job, and in the email itself.
    link: seal(ctx.keys.serverSecret, `${ctx.config.publicUrl}/s/${token}`),
  });
}

// ---------------------------------------------------------------------------
// Revoke / resend / archive / inline approval

export async function revokeDocument(ctx: Ctx, actor: Actor, id: string, reason?: string): Promise<DocumentView> {
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    const status = transition(doc.status as never, "revoke");
    const t = now();
    await trx
      .updateTable("documents")
      .set({ status, revoked_at: t, updated_at: t, revoke_reason: reason?.slice(0, 1000) ?? null })
      .where("id", "=", id)
      .execute();
    const signers = await loadSigners(trx, id);
    await trx.updateTable("signers").set({ token_hash: null }).where("document_id", "=", id).execute();
    await appendEvent(trx, id, "document.revoked", actor, { reason: reason ?? null });
    for (const s of signers) {
      if (s.notified_at && s.status !== "signed") {
        await enqueueJob(trx, "email", { kind: "revoked", document_id: id, signer_id: s.id });
      }
    }
  });
  return getDocument(ctx, actor, id);
}

export async function resendToSigner(ctx: Ctx, actor: Actor, id: string, key: string): Promise<DocumentView> {
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    if (doc.status !== "sent" && doc.status !== "partially_signed") {
      throw new SignedError("INVALID_TRANSITION", `Cannot resend a link for a ${doc.status} document`);
    }
    const signer = (await loadSigners(trx, id)).find((s) => s.key === key);
    if (!signer) throw new SignedError("SIGNER_INVALID", `Document has no signer '${key}'`);
    if (signer.status === "pending") throw new SignedError("INVALID_TRANSITION", `Signer '${key}' has not been notified yet. Their signing group is not active.`);
    if (signer.status === "signed" || signer.status === "declined") throw new SignedError("INVALID_TRANSITION", `Signer '${key}' has already ${signer.status}`);
    const recent = await trx
      .selectFrom("events")
      .select("created_at")
      .where("document_id", "=", id)
      .where("type", "=", "signer.notified")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    if (recent && Date.now() - Date.parse(recent.created_at) < 60_000) {
      throw new SignedError("RATE_LIMITED", "A link was sent less than a minute ago. Try again shortly.");
    }
    await appendEvent(trx, id, "signer.link_resent", actor, { signer: key });
    await issueToken(ctx, trx, id, signer, "reminder");
  });
  return getDocument(ctx, actor, id);
}

/** File a document in a folder, or take it out (null). Allowed in any status: folders only organise. */
export async function moveDocument(ctx: Ctx, actor: Actor, id: string, folderId: string | null): Promise<DocumentView> {
  const doc = await loadDocument(ctx.db, id);
  requireManageDocument(actor, doc);
  const folder = await folderFor(ctx, "document", folderId);
  await ctx.db.updateTable("documents").set({ folder_id: folder }).where("id", "=", id).execute();
  return getDocument(ctx, actor, id);
}

export async function setDocumentArchived(ctx: Ctx, actor: Actor, id: string, archived: boolean): Promise<DocumentView> {
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    if ((doc.archived_at !== null) === archived) return;
    await trx.updateTable("documents").set({ archived_at: archived ? now() : null }).where("id", "=", id).execute();
    await appendEvent(trx, id, archived ? "document.archived" : "document.unarchived", actor);
  });
  return getDocument(ctx, actor, id);
}

/** UI only: a person approves an inline document revision when the account requires it. */
export async function approveInlineDocument(ctx: Ctx, actor: Actor, id: string, revision: string): Promise<DocumentView> {
  if (actor.kind !== "user") throw new SignedError("PERMISSION_DENIED", "Inline documents can only be approved by a person in the web UI");
  requirePermission(actor, "inline.approve");
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    if (doc.status !== "draft") throw new SignedError("DOCUMENT_NOT_DRAFT", "Only drafts can be approved");
    if (doc.revision !== revision) throw new SignedError("REVISION_MISMATCH", "The draft changed. Review it again.");
    await trx
      .updateTable("documents")
      .set({ inline_approved_by: actorRef(actor), inline_approved_at: now(), inline_approved_revision: revision })
      .where("id", "=", id)
      .execute();
    await appendEvent(trx, id, "document.inline_approved", actor, { revision });
  });
  return getDocument(ctx, actor, id);
}

/**
 * UI only: turn a template draft into an inline draft, so its text can be edited. The approved
 * template no longer protects the language, so the inline rules apply from here on (including
 * owner approval when the account requires it). The template version stays as the starting point.
 */
export async function convertToInline(ctx: Ctx, actor: Actor, id: string): Promise<DocumentView> {
  if (actor.kind !== "user") throw new SignedError("PERMISSION_DENIED", "Only a person can do this, in the web UI");
  const account = await getAccount(ctx);
  if (account.config.inline_documents === "disabled") throw new SignedError("INLINE_DISABLED", "Inline documents are disabled for this account. Change the template instead.");
  requirePermission(actor, "documents.create");
  await ctx.db.transaction().execute(async (trx) => {
    const doc = await lockDocument(ctx, trx, id);
    requireManageDocument(actor, doc);
    if (doc.status !== "draft") throw new SignedError("DOCUMENT_NOT_DRAFT", "Only drafts can be edited. Revoke and create a new document instead.");
    if (doc.source_kind === "inline") return;
    await trx
      .updateTable("documents")
      .set({ source_kind: "inline", inline_approved_by: null, inline_approved_at: null, inline_approved_revision: null, updated_at: now() })
      .where("id", "=", id)
      .execute();
    await appendEvent(trx, id, "document.converted_to_inline", actor, { template_version_id: doc.template_version_id, revision: doc.revision });
  });
  return getDocument(ctx, actor, id);
}

// ---------------------------------------------------------------------------
// Read

export interface DocumentView {
  id: string;
  title: string;
  status: DocumentStatus;
  /** The person who owns and sent the document. */
  owner: { id: string; name: string; email: string } | null;
  revision: string;
  source: "template" | "inline";
  template: { id: string; version: number } | null;
  values: Record<string, unknown>;
  signers: {
    key: string;
    name: string;
    email: string;
    order: number;
    status: SignerRow["status"];
    notified_at: string | null;
    viewed_at: string | null;
    signed_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
  }[];
  current_signing_group: number | null;
  outstanding: { signer: string; action: "sign" }[];
  validation: { valid: boolean; errors: Issue[] } | null;
  approved_revision: string | null;
  approved_by: string | null;
  inline_approval: { required: boolean; approved: boolean; approved_at: string | null } | null;
  expires_in_days: number;
  expires_at: string | null;
  timezone: string;
  locale: string;
  webhook_url: string | null;
  font: ContractFont;
  message: string | null;
  metadata: Record<string, unknown>;
  archived: boolean;
  folder: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  completed_at: string | null;
  finalized_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  links: { self: string; preview: string; artifacts: string; ui: string };
}

export async function getDocument(ctx: Ctx, actor: Actor, id: string): Promise<DocumentView> {
  const doc = await loadDocument(ctx.db, id);
  requireReadDocument(actor, doc);
  const signers = await loadSigners(ctx.db, id);
  return documentView(ctx, doc, signers, (await getAccount(ctx)).config.inline_documents);
}

export async function documentView(ctx: Ctx, doc: DocRow, signers: SignerRow[], inlineSetting: string): Promise<DocumentView> {
  const active = ["sent", "partially_signed"].includes(doc.status);
  const unsigned = signers.filter((s) => s.status !== "signed");
  const currentGroup = active && unsigned.length > 0 ? Math.min(...unsigned.map((s) => Number(s.signing_order))) : null;
  let validation: DocumentView["validation"] = null;
  if (doc.status === "draft") {
    const p = prepareFrom(doc, signerInputs(signers));
    validation = { valid: p.valid, errors: p.issues };
  }
  let template: DocumentView["template"] = null;
  if (doc.template_version_id) {
    const tv = await ctx.db.selectFrom("template_versions").select(["template_id", "version"]).where("id", "=", doc.template_version_id).executeTakeFirst();
    if (tv) template = { id: tv.template_id, version: Number(tv.version) };
  }
  const base = `${ctx.config.publicUrl}/v1/documents/${doc.id}`;
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status as DocumentStatus,
    owner: await userById(ctx, doc.owner_user_id).then((u) => (u ? { id: u.id, name: u.name, email: u.email } : null)),
    revision: doc.revision,
    source: doc.source_kind,
    template,
    values: JSON.parse(doc.values_json) as Record<string, unknown>,
    signers: signers.map((s) => ({
      key: s.key,
      name: s.name,
      email: s.email,
      order: Number(s.signing_order),
      status: s.status,
      notified_at: s.notified_at,
      viewed_at: s.viewed_at,
      signed_at: s.signed_at,
      declined_at: s.declined_at,
      decline_reason: s.decline_reason,
    })),
    current_signing_group: currentGroup,
    outstanding: active ? signers.filter((s) => s.status === "notified" || s.status === "viewed").map((s) => ({ signer: s.key, action: "sign" as const })) : [],
    validation,
    approved_revision: doc.approved_revision,
    approved_by: doc.approved_by,
    inline_approval:
      doc.source_kind === "inline"
        ? {
            required: inlineSetting === "needs_approval",
            approved: doc.inline_approved_revision !== null && doc.inline_approved_revision === doc.revision,
            approved_at: doc.inline_approved_at,
          }
        : null,
    expires_in_days: Number(doc.expires_in_days),
    expires_at: doc.expires_at,
    timezone: doc.timezone,
    locale: doc.locale,
    webhook_url: doc.webhook_url,
    font: fontOf(doc.font),
    message: doc.signer_message,
    metadata: JSON.parse(doc.metadata) as Record<string, unknown>,
    archived: doc.archived_at !== null,
    folder: doc.folder_id ? { id: doc.folder_id, name: (await folderNames(ctx, [doc.folder_id])).get(doc.folder_id) ?? "" } : null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    sent_at: doc.sent_at,
    completed_at: doc.completed_at,
    finalized_at: doc.finalized_at,
    revoked_at: doc.revoked_at,
    revoke_reason: doc.revoke_reason,
    links: { self: base, preview: `${base}/preview`, artifacts: `${base}/artifacts`, ui: `${ctx.config.publicUrl}/documents/${doc.id}` },
  };
}

export interface ListDocumentsOptions {
  /** Only documents you own. Members always see only their own. */
  mine?: boolean;
  status?: string;
  archived?: boolean;
  q?: string;
  limit?: number;
  /** next_before from the previous page: the older page. */
  before?: string;
  /** newer_after from a page: the newer page (web UI only). */
  after?: string;
  /** A folder id, or "none" for documents in no folder. */
  folder?: string;
}

/** A list cursor: the created_at and id of a row, so rows created in the same millisecond are never skipped. */
function encodeCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}|${row.id}`;
}
function decodeCursor(cursor: string): { at: string; id: string | null } {
  const i = cursor.indexOf("|");
  return i < 0 ? { at: cursor, id: null } : { at: cursor.slice(0, i), id: cursor.slice(i + 1) }; // a bare timestamp: older cursors
}

/**
 * Documents, newest first, a page at a time. `before` (next_before of a page) gives the older page and
 * `after` (newer_after) the newer one. A newer page that would come up short is the first page instead.
 */
export async function listDocuments(ctx: Ctx, actor: Actor, opts: ListDocumentsOptions = {}): Promise<{ data: DocumentView[]; next_before: string | null; newer_after: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const newer = !opts.before && !!opts.after;
  let q = ctx.db.selectFrom("documents").selectAll().limit(limit + 1);
  q = newer ? q.orderBy("created_at", "asc").orderBy("id", "asc") : q.orderBy("created_at", "desc").orderBy("id", "desc");
  q = opts.archived ? q.where("archived_at", "is not", null) : q.where("archived_at", "is", null);
  if (opts.status) q = q.where("status", "=", opts.status);
  if (opts.folder === "none") q = q.where("folder_id", "is", null);
  else if (opts.folder) q = q.where("folder_id", "=", opts.folder);
  if (opts.mine || !(can(actor, "documents.read_all") || can(actor, "documents.manage_all"))) q = q.where("owner_user_id", "=", userIdOf(actor) ?? "");
  const cursor = opts.before ?? opts.after;
  if (cursor) {
    const c = decodeCursor(cursor);
    const op = newer ? ">" : "<";
    q = c.id === null
      ? q.where("created_at", op, c.at)
      : q.where((eb) => eb.or([eb("created_at", op, c.at), eb.and([eb("created_at", "=", c.at), eb("id", op, c.id!)])]));
  }
  if (opts.q) {
    const term = `%${opts.q.toLowerCase().replace(/[%_]/g, "")}%`;
    q = q.where((eb) =>
      eb.or([
        eb(eb.fn("lower", ["title"]), "like", term),
        eb("id", "in", eb.selectFrom("signers").select("document_id").where((e2) => e2.or([e2(e2.fn("lower", ["email"]), "like", term), e2(e2.fn("lower", ["name"]), "like", term)]))),
      ]),
    );
  }
  const rows = await q.execute();
  const more = rows.length > limit;
  if (newer && !more) return listDocuments(ctx, actor, { ...opts, after: undefined });
  const page = newer ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
  const setting = (await getAccount(ctx)).config.inline_documents;
  const data = await Promise.all(page.map(async (d) => documentView(ctx, d, await loadSigners(ctx.db, d.id), setting)));
  const first = page[0], last = page[page.length - 1];
  return {
    data,
    next_before: last && (newer || more) ? encodeCursor(last) : null,
    newer_after: first && (newer || !!cursor) ? encodeCursor(first) : null,
  };
}
