import {
  AGREEMENT_FORMAT,
  canonicalJson,
  EVIDENCE_FORMAT,
  type FieldDef,
  MANIFEST_FORMAT,
  type Manifest,
  SignedError,
  transition,
} from "@signed-md/core";
import { enqueueJob, newId, now } from "@signed-md/db";
import { zipSync } from "fflate";
import type { Actor, Ctx } from "../context.ts";
import { requireReadDocument } from "./permissions.ts";
import { hmacHex, safeEqual, sha256 } from "../crypto.ts";
import { getAccount } from "./accounts.ts";
import { appendEvent, listEvents } from "./events.ts";
import { loadDocument, loadSigners, lockDocument } from "./documents.ts";
import { renderPdf } from "./pdf.ts";
import { certificatePem, pdfIdentity, signPdf } from "./pdfsign.ts";
import { requestTimestamp } from "./tsa.ts";
import { createHash } from "node:crypto";
import { log } from "../log.ts";
import { DISCLOSURE_VERSION, type SignerFieldValue } from "./signing.ts";
import { emitWebhook } from "./webhooks.ts";

/** Fixed timestamp inside the ZIP so the archive bytes depend only on its contents. */
const ZIP_MTIME = new Date("2000-01-01T00:00:00Z");

/**
 * Render the PDF, build and sign the completion package, and move the document to `finalized`.
 * Idempotent: running it twice does not create a second package.
 */
export async function finalizeDocument(ctx: Ctx, documentId: string): Promise<void> {
  const doc = await loadDocument(ctx.db, documentId);
  if (doc.status === "finalized") return;
  if (doc.status !== "signed") throw new SignedError("INVALID_TRANSITION", `Cannot finalize a ${doc.status} document`);

  const account = await getAccount(ctx);
  const signers = await loadSigners(ctx.db, documentId);
  const fieldRows = await ctx.db.selectFrom("fields").selectAll().where("document_id", "=", documentId).orderBy("position").execute();
  const fields = fieldRows.map((f) => JSON.parse(f.definition) as FieldDef);
  const signerValues = new Map<string, SignerFieldValue>();
  for (const f of fieldRows) if (f.kind === "signer" && f.value !== null) signerValues.set(f.key, JSON.parse(f.value) as SignerFieldValue);

  let template: { id: string; version: number; content_hash: string } | null = null;
  if (doc.template_version_id) {
    const tv = await ctx.db.selectFrom("template_versions").select(["template_id", "version", "content_hash"]).where("id", "=", doc.template_version_id).executeTakeFirstOrThrow();
    template = { id: tv.template_id, version: Number(tv.version), content_hash: tv.content_hash };
  }

  // Record finalization first, so the event is part of the packaged evidence.
  const finalizedAt = now();
  const contentSha = sha256(doc.content);
  const preEvents = await listEvents(ctx.db, documentId);
  const signedMeta = new Map<string, { ip: string | null; user_agent: string | null }>();
  for (const e of preEvents) {
    if (e.type === "signer.signed") signedMeta.set(String(e.data.signer), { ip: (e.data.ip as string | null) ?? null, user_agent: (e.data.user_agent as string | null) ?? null });
  }
  // Each signer's adopted signature (their first signature field), shown on the certificate.
  const signatureOf = (key: string) => {
    const f = fieldRows.find((r) => r.signer_key === key && r.type === "signature" && r.value !== null) ?? fieldRows.find((r) => r.signer_key === key && r.type === "initials" && r.value !== null);
    return f ? (JSON.parse(f.value!) as SignerFieldValue) : null;
  };

  // Reuse a PDF from an earlier, interrupted attempt so its hash in the evidence stays correct.
  const dir = `documents/${documentId}`;
  const existing = await ctx.storage.read(`${dir}/signed.pdf`).catch(() => null);
  const identity = pdfIdentity(ctx.config.dataDir, account.name);
  const owner = doc.owner_user_id ? await ctx.db.selectFrom("users").select(["name", "email"]).where("id", "=", doc.owner_user_id).executeTakeFirst() : undefined;
  // The certificate (inside the PDF) states that timestamps are present only when the authority answers now.
  let tsaReachable = false;
  if (!existing && ctx.config.tsaUrl) {
    tsaReachable = await requestTimestamp(ctx.config.tsaUrl, createHash("sha256").update(doc.content).digest(), 8_000).then(() => true, () => false);
  }
  const rendered = existing ? null : await renderPdf(ctx.config.typstBin, {
    title: doc.title,
    documentId,
    revision: doc.revision,
    content: doc.content,
    contentSha256: contentSha,
    fields,
    values: signerValues,
    signers: signers.map((s) => ({
      key: s.key,
      name: s.name,
      email: s.email,
      order: Number(s.signing_order),
      notified_at: s.notified_at,
      viewed_at: s.viewed_at,
      consented_at: s.consented_at,
      signed_at: s.signed_at,
      ip: signedMeta.get(s.key)?.ip ?? null,
      user_agent: signedMeta.get(s.key)?.user_agent ?? null,
      signature: signatureOf(s.key),
    })),
    sender: owner ? { name: owner.name || owner.email, email: owner.email } : null,
    source: template ? `Template version ${template.version}` : "Inline Markdown",
    sentAt: doc.sent_at,
    sealedBy: (/CN=([^\n,]+)/.exec(identity.chain[0]!.subject)?.[1] ?? identity.chain[0]!.subject).trim(),
    timestampAuthority: tsaReachable && ctx.config.tsaUrl ? new URL(ctx.config.tsaUrl).host : null,
    disclosureVersion: DISCLOSURE_VERSION,
    completedAt: doc.completed_at ?? finalizedAt,
    accountName: account.name,
    publicUrl: ctx.config.publicUrl,
    keyId: ctx.keys.info.kid,
    timezone: doc.timezone,
  });
  // Seal the PDF: a PAdES signature (with a trusted timestamp when the authority is reachable).
  let pdf: Buffer;
  let pdfTimestamped = false;
  if (existing) pdf = existing;
  else {
    const sealed = await signPdf(rendered!, identity, {
      reason: "All parties signed this document electronically with Signed.md",
      location: new URL(ctx.config.publicUrl).host,
      name: account.name,
      contactInfo: owner?.email ?? "",
      signingTime: new Date(),
      tsaUrl: tsaReachable ? ctx.config.tsaUrl : null,
    });
    pdf = sealed.pdf;
    pdfTimestamped = sealed.timestamped;
    await ctx.storage.write(`${dir}/signed.pdf`, pdf);
  }

  await ctx.db.transaction().execute(async (trx) => {
    const locked = await lockDocument(ctx, trx, documentId);
    if (locked.status !== "signed") return;
    const hasFinal = await trx.selectFrom("events").select("id").where("document_id", "=", documentId).where("type", "=", "document.finalized").executeTakeFirst();
    if (!hasFinal) {
      await appendEvent(trx, documentId, "document.finalized", { kind: "system", id: "system", label: "Signed.md" }, {
        pdf_sha256: sha256(pdf),
        key_id: ctx.keys.info.kid,
        pdf_signature: { standard: "PAdES (ETSI.CAdES.detached)", certificate: identity.chain[0]!.subject.replace(/\n/g, ", "), timestamped: pdfTimestamped },
      });
    }
  });

  const events = (await listEvents(ctx.db, documentId)).map(({ id: _id, ...e }) => e);

  const agreement = {
    format: AGREEMENT_FORMAT,
    document_id: documentId,
    title: doc.title,
    revision: doc.revision,
    source: doc.source_kind,
    template,
    account: { id: account.id, name: account.name },
    values: JSON.parse(doc.values_json),
    resolved_values: Object.fromEntries(fieldRows.filter((f) => f.kind === "value").map((f) => [f.key, f.value === null ? null : JSON.parse(f.value)])),
    fields,
    signers: signers.map((s) => ({
      key: s.key,
      name: s.name,
      email: s.email,
      order: Number(s.signing_order),
      notified_at: s.notified_at,
      viewed_at: s.viewed_at,
      consented_at: s.consented_at,
      signed_at: s.signed_at,
      identity: { email_link_access: true, identity_verified: false },
    })),
    approved_revision: doc.approved_revision,
    approved_by: { statement: doc.approved_by, verified: false },
    sent_at: doc.sent_at,
    completed_at: doc.completed_at,
    timezone: doc.timezone,
    locale: doc.locale,
    metadata: JSON.parse(doc.metadata),
  };
  const signatures = {
    fields: fieldRows
      .filter((f) => f.kind === "signer" && f.value !== null)
      .map((f) => ({ key: f.key, signer: f.signer_key, type: f.type, completed_at: f.completed_at, value: JSON.parse(f.value!) })),
  };

  const enc = (o: unknown) => Buffer.from(JSON.stringify(o, null, 2) + "\n");
  const files: Record<string, Uint8Array> = {
    "agreement.md": Buffer.from(doc.content),
    "agreement.json": enc(agreement),
    "signatures.json": enc(signatures),
    "evidence.json": enc({ format: EVIDENCE_FORMAT, events }),
    "signed.pdf": pdf,
    // The manifest key, plus the certificate that signed the PDF, bound together by the manifest signature.
    "public-key.json": enc({ ...ctx.keys.info, pdf_signing_certificate: certificatePem(identity.chain[0]!) }),
  };
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    document_id: documentId,
    revision: doc.revision,
    created_at: finalizedAt,
    key_id: ctx.keys.info.kid,
    alg: "Ed25519",
    files: Object.entries(files).map(([path, data]) => ({ path, sha256: sha256(data), size: data.length })),
  };
  files["manifest.json"] = enc(manifest);
  files["manifest.sig"] = Buffer.from(ctx.keys.sign(canonicalJson(manifest)) + "\n");
  // An independent timestamp authority attests when the package existed (RFC 3161). Best effort.
  if (ctx.config.tsaUrl) {
    try {
      files["manifest.tsr"] = await requestTimestamp(ctx.config.tsaUrl, createHash("sha256").update(canonicalJson(manifest)).digest());
    } catch (e) {
      log.warn("timestamp authority unavailable; package not timestamped", { error: (e as Error).message });
    }
  }

  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { mtime: ZIP_MTIME }]])), { level: 6 });

  await ctx.storage.write(`${dir}/agreement.zip`, zip);

  await ctx.db.transaction().execute(async (trx) => {
    const locked = await lockDocument(ctx, trx, documentId);
    if (locked.status !== "signed") return;
    const t = now();
    for (const [type, data, path] of [
      ["pdf", pdf, `${dir}/signed.pdf`],
      ["zip", zip, `${dir}/agreement.zip`],
    ] as const) {
      await trx
        .insertInto("artifacts")
        .values({ id: newId("art"), document_id: documentId, type, storage_path: path, sha256: sha256(data), size: data.length, created_at: t })
        .onConflict((oc) => oc.columns(["document_id", "type"]).doNothing())
        .execute();
    }
    const status = transition("signed", "finalize");
    await trx.updateTable("documents").set({ status, finalized_at: t, updated_at: t }).where("id", "=", documentId).execute();
    const zipArt = await trx.selectFrom("artifacts").selectAll().where("document_id", "=", documentId).where("type", "=", "zip").executeTakeFirstOrThrow();
    await emitWebhook(ctx, trx, { ...locked, status }, "document.finalized", {
      artifact: { ...downloadLink(ctx, zipArt.id, 24 * 3600), sha256: zipArt.sha256, size: Number(zipArt.size) },
    });
    for (const s of signers) await enqueueJob(trx, "email", { kind: "completed", document_id: documentId, signer_id: s.id });
    await enqueueJob(trx, "email", { kind: "completed_sender", document_id: documentId });
  });
}

// ---------------------------------------------------------------------------
// Artifacts and signed download links

export function downloadLink(ctx: Ctx, artifactId: string, ttlSeconds: number): { url: string; expires_at: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmacHex(ctx.keys.serverSecret, `download:${artifactId}:${exp}`);
  return { url: `${ctx.config.publicUrl}/download/${artifactId}?exp=${exp}&sig=${sig}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function checkDownloadSignature(ctx: Ctx, artifactId: string, exp: string, sig: string): boolean {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Date.now() / 1000) return false;
  return safeEqual(sig, hmacHex(ctx.keys.serverSecret, `download:${artifactId}:${e}`));
}

export async function listArtifacts(ctx: Ctx, actor: Actor, documentId: string, ttlSeconds = 3600) {
  const doc = await loadDocument(ctx.db, documentId);
  requireReadDocument(actor, doc);
  if (doc.status !== "finalized") {
    throw new SignedError("DOCUMENT_NOT_FINALIZED", `Artifacts are ready once the document is finalized. Current status: ${doc.status}.`);
  }
  const rows = await ctx.db.selectFrom("artifacts").selectAll().where("document_id", "=", documentId).orderBy("type").execute();
  return rows.map((a) => ({
    id: a.id,
    type: a.type as "pdf" | "zip",
    filename: a.type === "zip" ? `${slug(doc.title)}-${documentId}.zip` : `${slug(doc.title)}-${documentId}.pdf`,
    sha256: a.sha256,
    size: Number(a.size),
    created_at: a.created_at,
    download: downloadLink(ctx, a.id, ttlSeconds),
  }));
}

export async function readArtifact(ctx: Ctx, artifactId: string) {
  const a = await ctx.db.selectFrom("artifacts").selectAll().where("id", "=", artifactId).executeTakeFirst();
  if (!a) return null;
  const doc = await loadDocument(ctx.db, a.document_id);
  const data = await ctx.storage.read(a.storage_path);
  return {
    data,
    type: a.type,
    filename: a.type === "zip" ? `${slug(doc.title)}-${doc.id}.zip` : `${slug(doc.title)}-${doc.id}.pdf`,
    contentType: a.type === "zip" ? "application/zip" : "application/pdf",
  };
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "agreement";
}
