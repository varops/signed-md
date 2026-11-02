import { createHash, createPublicKey, verify as edVerify, X509Certificate } from "node:crypto";
import { parseSignedData, parseTimestampToken } from "./cms.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

/** Package format identifiers. Bump on incompatible changes. */
export const MANIFEST_FORMAT = "signed-md/manifest@1";
export const EVIDENCE_FORMAT = "signed-md/evidence@1";
export const AGREEMENT_FORMAT = "signed-md/agreement@1";

export interface EvidenceEvent {
  document_id: string;
  seq: number;
  type: string;
  actor: string;
  actor_label: string;
  created_at: string;
  data: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

/** The exact bytes hashed for each event in the chain. */
export function eventHashInput(e: Omit<EvidenceEvent, "hash">): string {
  return canonicalJson({
    document_id: e.document_id,
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    actor_label: e.actor_label,
    created_at: e.created_at,
    data: e.data,
    prev_hash: e.prev_hash,
  });
}

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  document_id: string;
  revision: string;
  created_at: string;
  key_id: string;
  alg: "Ed25519";
  files: ManifestFile[];
}

export interface PublicKeyFile {
  kid: string;
  alg: "Ed25519";
  public_key: string;
  public_key_pem?: string;
  created_at?: string;
  /** PEM certificate that signed signed.pdf (PAdES). */
  pdf_signing_certificate?: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  document_id: string | null;
  title: string | null;
  revision: string | null;
  key_id: string | null;
  /** True when the signing key matched a key the caller trusts (not just the key inside the package). */
  trusted_key: boolean;
  signers: { key: string; name: string; email: string; signed_at: string | null }[];
  /** RFC 3161 timestamp on the manifest, if present. */
  timestamp: { time: string; authority: string } | null;
  /** The PDF's own digital signature (PAdES), if present. */
  pdf_signature: { signer: string; signed_at_timestamp: string | null; timestamp_authority: string | null } | null;
  checks: VerifyCheck[];
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

/** Verify the last PAdES signature in a PDF. Returns null when the PDF has no signature. */
export function verifyPdfSignature(pdf: Uint8Array, expectedCertPem?: string): {
  checks: VerifyCheck[];
  signer: string;
  timestamp: { time: string; authority: string } | null;
} | null {
  const text = Buffer.from(pdf).toString("latin1");
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const last = ranges.at(-1);
  if (!last) return null;
  const [a, b, c, d] = last.slice(1, 5).map(Number) as [number, number, number, number];
  const checks: VerifyCheck[] = [];
  const hex = text.slice(b, c).replace(/^</, "").replace(/>$/, "").trim();
  const cms = Buffer.from(hex, "hex");
  const digest = sha(Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]));
  let info;
  try {
    info = parseSignedData(cms);
  } catch (e) {
    return { checks: [{ name: "PDF signature readable", ok: false, detail: (e as Error).message }], signer: "", timestamp: null };
  }
  const signer = info.certificate.subject.replace(/\n/g, ", ");
  checks.push({ name: "PDF signature valid", ok: info.signatureValid && Buffer.from(info.messageDigest).equals(digest), detail: signer });
  checks.push({ name: "PDF not changed after signing", ok: a === 0 && c + d === pdf.length });
  checks.push({ name: "PDF signature is PAdES (signing certificate bound)", ok: info.signingCertificateBound });
  if (expectedCertPem) {
    const same = Buffer.from(new X509Certificate(expectedCertPem).raw).equals(Buffer.from(info.certificate.raw));
    checks.push({ name: "PDF signed by this installation's certificate", ok: same });
  }
  let timestamp: { time: string; authority: string } | null = null;
  if (info.timestampToken) {
    try {
      const ts = parseTimestampToken(info.timestampToken);
      const ok = ts.signatureValid && Buffer.from(ts.imprint).equals(sha(info.signatureValue));
      checks.push({ name: "PDF signature timestamp", ok, detail: `${ts.genTime.toISOString()} by ${ts.authority}` });
      timestamp = { time: ts.genTime.toISOString(), authority: ts.authority };
    } catch (e) {
      checks.push({ name: "PDF signature timestamp", ok: false, detail: (e as Error).message });
    }
  }
  return { checks, signer, timestamp };
}

export interface VerifyOptions {
  /** Public keys the caller trusts, as SPKI DER base64 (the `public_key` value). */
  trustedKeys?: string[];
}

/**
 * Verify an unpacked completion package. Works offline: needs only the package files
 * and, optionally, the public keys you trust.
 */
export function verifyPackageFiles(files: Record<string, Uint8Array>, opts: VerifyOptions = {}): VerifyReport {
  const checks: VerifyCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };
  const text = (p: string) => (files[p] ? Buffer.from(files[p]!).toString("utf8") : null);
  const json = <T>(p: string): T | null => {
    const t = text(p);
    if (t === null) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      return null;
    }
  };

  const report: VerifyReport = { ok: false, document_id: null, title: null, revision: null, key_id: null, trusted_key: false, signers: [], timestamp: null, pdf_signature: null, checks };

  const manifest = json<Manifest>("manifest.json");
  const sig = text("manifest.sig")?.trim() ?? null;
  const pub = json<PublicKeyFile>("public-key.json");
  if (!check("manifest present", manifest !== null && manifest.format === MANIFEST_FORMAT)) return report;
  if (!check("signature present", sig !== null && sig.length > 0)) return report;
  if (!check("public key present", pub !== null && pub.alg === "Ed25519")) return report;
  report.document_id = manifest!.document_id;
  report.revision = manifest!.revision;
  report.key_id = manifest!.key_id;

  // 1. Manifest signature.
  let sigOk = false;
  try {
    const key = createPublicKey({ key: Buffer.from(pub!.public_key, "base64"), format: "der", type: "spki" });
    sigOk = edVerify(null, Buffer.from(canonicalJson(manifest)), key, Buffer.from(sig!, "base64"));
  } catch {
    sigOk = false;
  }
  check("manifest signature valid", sigOk);
  check("key id matches", pub!.kid === manifest!.key_id, `${pub!.kid} / ${manifest!.key_id}`);
  if (opts.trustedKeys && opts.trustedKeys.length > 0) {
    report.trusted_key = opts.trustedKeys.includes(pub!.public_key);
    check("signing key is trusted", report.trusted_key, report.trusted_key ? pub!.kid : "The package was signed with a key you did not list as trusted");
  }

  // 2. File hashes. Every file except the manifest and its signature must be listed.
  const listed = new Set(manifest!.files.map((f) => f.path));
  for (const f of manifest!.files) {
    const data = files[f.path];
    check(`file ${f.path}`, data !== undefined && sha256Hex(data) === f.sha256 && data.length === f.size, data === undefined ? "missing" : undefined);
  }
  const extra = Object.keys(files).filter((p) => !listed.has(p) && !["manifest.json", "manifest.sig", "manifest.tsr"].includes(p));
  check("no unlisted files", extra.length === 0, extra.length ? extra.join(", ") : undefined);

  // 2b. Trusted timestamp on the manifest (RFC 3161), if present.
  if (files["manifest.tsr"]) {
    try {
      const ts = parseTimestampToken(files["manifest.tsr"]);
      const ok = ts.signatureValid && Buffer.from(ts.imprint).equals(sha(Buffer.from(canonicalJson(manifest))));
      check("package timestamp", ok, `${ts.genTime.toISOString()} by ${ts.authority}`);
      if (ok) report.timestamp = { time: ts.genTime.toISOString(), authority: ts.authority };
    } catch (e) {
      check("package timestamp", false, (e as Error).message);
    }
  }

  // 2c. The PDF's own signature (PAdES), checked against the certificate the signed package declares.
  if (files["signed.pdf"]) {
    const pdfSig = verifyPdfSignature(files["signed.pdf"], pub!.pdf_signing_certificate);
    if (pdfSig) {
      for (const c of pdfSig.checks) check(c.name, c.ok, c.detail);
      report.pdf_signature = { signer: pdfSig.signer, signed_at_timestamp: pdfSig.timestamp?.time ?? null, timestamp_authority: pdfSig.timestamp?.authority ?? null };
    }
  }

  // 3. Evidence hash chain.
  const evidence = json<{ format: string; events: EvidenceEvent[] }>("evidence.json");
  let chainOk = evidence !== null && evidence.format === EVIDENCE_FORMAT && evidence.events.length > 0;
  let prev: string | null = null;
  for (const [i, e] of (evidence?.events ?? []).entries()) {
    const { hash, ...rest } = e;
    if (e.seq !== i + 1 || e.prev_hash !== prev || sha256Hex(eventHashInput(rest)) !== hash || e.document_id !== manifest!.document_id) {
      chainOk = false;
      check("evidence chain", false, `event ${e.seq} (${e.type}) does not match the chain`);
      break;
    }
    prev = hash;
  }
  if (chainOk) check("evidence chain", true, `${evidence!.events.length} events`);

  // 4. Agreement content matches what was sent and signed.
  const agreement = json<{
    format: string;
    title: string;
    revision: string;
    signers: { key: string; name: string; email: string; signed_at: string | null }[];
  }>("agreement.json");
  const md = files["agreement.md"];
  if (agreement) {
    report.title = agreement.title;
    report.signers = agreement.signers.map((s) => ({ key: s.key, name: s.name, email: s.email, signed_at: s.signed_at }));
    check("revision matches manifest", agreement.revision === manifest!.revision);
  } else {
    check("agreement.json readable", false);
  }
  const events = evidence?.events ?? [];
  const sent = events.find((e) => e.type === "document.sent");
  const mdHash = md ? sha256Hex(md) : null;
  check("agreement.md matches the sent document", sent !== undefined && mdHash !== null && sent.data.content_sha256 === mdHash);

  // 5. Every signer signed this exact content, and their stored values match the evidence.
  const sigs = json<{ fields: { key: string; signer: string; value: unknown }[] }>("signatures.json");
  for (const s of agreement?.signers ?? []) {
    const ev = events.find((e) => e.type === "signer.signed" && e.data.signer === s.key);
    const consent = events.find((e) => e.type === "signer.consented" && e.data.signer === s.key);
    let ok = ev !== undefined && consent !== undefined && ev.data.content_sha256 === mdHash;
    const evFields = (ev?.data.fields as { key: string; value_sha256: string }[] | undefined) ?? [];
    for (const f of evFields) {
      const stored = sigs?.fields.find((x) => x.key === f.key);
      if (!stored || sha256Hex(JSON.stringify(stored.value)) !== f.value_sha256) ok = false;
    }
    check(`signer ${s.key} signed`, ok, `${s.name} <${s.email}>`);
  }

  report.ok = checks.every((c) => c.ok);
  return report;
}
