import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { der, derDecode } from "@signed-md/core/der";
import { OID } from "@signed-md/core/cms";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { SignPdf } from "@signpdf/signpdf";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import forge from "node-forge";
import { log } from "../log.ts";
import { requestTimestamp } from "./tsa.ts";

export interface SigningIdentity {
  key: KeyObject;
  /** Leaf first, then any intermediates. */
  chain: X509Certificate[];
}

function sha256(b: Uint8Array): Buffer {
  return createHash("sha256").update(b).digest();
}

/**
 * The certificate that signs completed PDFs (PAdES). By default each installation creates a
 * self-signed RSA certificate in DATA_DIR/keys. PDF readers then show the signature as intact but
 * the signer as "unknown". To get a trusted (green) signature in Adobe Reader, set
 * PDF_SIGNING_KEY_FILE and PDF_SIGNING_CERT_FILE to a certificate from an Adobe AATL provider.
 */
export function loadSigningIdentity(dataDir: string, accountName: string, env: NodeJS.ProcessEnv = process.env): SigningIdentity {
  if (env.PDF_SIGNING_KEY_FILE && env.PDF_SIGNING_CERT_FILE) {
    const key = createPrivateKey(readFileSync(env.PDF_SIGNING_KEY_FILE));
    const pems = readFileSync(env.PDF_SIGNING_CERT_FILE, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (pems.length === 0) throw new Error("PDF_SIGNING_CERT_FILE has no certificates");
    return { key, chain: pems.map((p) => new X509Certificate(p)) };
  }
  const keyPath = join(dataDir, "keys", "pdf-signing-key.pem");
  const certPath = join(dataDir, "keys", "pdf-signing-cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
    cert.serialNumber = "01" + randomBytes(15).toString("hex");
    cert.validity.notBefore = new Date(Date.now() - 86400_000);
    cert.validity.notAfter = new Date(Date.now() + 20 * 365 * 86400_000);
    const attrs = [
      { name: "commonName", value: `${accountName} (Signed.md)` },
      { name: "organizationName", value: accountName },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }).toString()), forge.md.sha256.create());
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(certPath, forge.pki.certificateToPem(cert));
    log.info("created PDF signing certificate", { subject: `${accountName} (Signed.md)` });
  }
  return { key: createPrivateKey(readFileSync(keyPath)), chain: [new X509Certificate(readFileSync(certPath))] };
}

/** issuerAndSerialNumber for the signer certificate, taken from the certificate's own DER. */
function issuerAndSerial(cert: X509Certificate): Uint8Array {
  const tbs = forge.asn1.fromDer(forge.util.createBuffer(cert.raw.toString("binary")));
  const tbsSeq = (tbs.value as forge.asn1.Asn1[])[0]!;
  const fields = tbsSeq.value as forge.asn1.Asn1[];
  const hasVersion = fields[0]!.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC;
  const serial = fields[hasVersion ? 1 : 0]!;
  const issuer = fields[hasVersion ? 3 : 2]!;
  const bytes = (n: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(n).getBytes(), "binary");
  return der.seq(bytes(issuer), bytes(serial));
}

function algorithmFor(key: KeyObject): { digest: string; sigAlg: Uint8Array } {
  if (key.asymmetricKeyType === "ec") return { digest: "sha256", sigAlg: der.seq(der.oid(OID.ecdsaWithSHA256)) };
  return { digest: "sha256", sigAlg: der.seq(der.oid(OID.sha256WithRSA), der.null()) };
}

const attr = (oid: string, value: Uint8Array) => der.seq(der.oid(oid), der.set(value));

/**
 * Build a CMS SignedData with one signer. Signed attributes: contentType, messageDigest, and
 * signing-certificate-v2 (no signingTime, as PAdES baseline requires). Used for PDF signatures
 * (detached, id-data) and, in tests, for timestamp tokens (attached TSTInfo).
 */
export function buildSignedData(
  identity: SigningIdentity,
  opts: { eContentType: string; digest: Uint8Array; content?: Uint8Array; unsignedAttrs?: Uint8Array[]; signature?: Uint8Array },
): { contentInfo: Uint8Array; signature: Uint8Array } {
  const leaf = identity.chain[0]!;
  // signing-certificate-v2: SEQUENCE { certs SEQUENCE OF ESSCertIDv2 { certHash } } (SHA-256 is the default algorithm).
  const signedSet = der.set(
    attr(OID.contentType, der.oid(opts.eContentType)),
    attr(OID.messageDigest, der.octet(opts.digest)),
    attr(OID.signingCertificateV2, der.seq(der.seq(der.seq(der.octet(sha256(leaf.raw)))))),
  );
  const { digest: alg, sigAlg } = algorithmFor(identity.key);
  // Unsigned attributes are outside the signature, so a timestamp can be added to an existing signature value.
  const signature = opts.signature ?? new Uint8Array(sign(alg, signedSet, identity.key));
  const signerInfo = der.seq(
    der.int(1),
    issuerAndSerial(leaf),
    der.seq(der.oid(OID.sha256), der.null()),
    // The same attributes, tagged [0] IMPLICIT instead of SET.
    der.ctx(0, derDecode(signedSet).value),
    sigAlg,
    der.octet(signature),
    ...(opts.unsignedAttrs?.length ? [der.ctx(1, der.concat(opts.unsignedAttrs))] : []),
  );
  const encap = opts.content ? der.seq(der.oid(opts.eContentType), der.ctx(0, der.octet(opts.content))) : der.seq(der.oid(opts.eContentType));
  const signedData = der.seq(
    der.int(opts.content ? 3 : 1),
    der.set(der.seq(der.oid(OID.sha256), der.null())),
    encap,
    der.ctx(0, der.concat(identity.chain.map((c) => new Uint8Array(c.raw)))),
    der.set(signerInfo),
  );
  return { contentInfo: der.seq(der.oid(OID.signedData), der.ctx(0, signedData)), signature };
}

/**
 * CAdES detached signature for a PDF (PAdES baseline B-B). With a reachable timestamp authority,
 * the signature value is timestamped (B-T): an unsigned signature-time-stamp attribute.
 */
export async function buildCadesSignature(identity: SigningIdentity, digest: Uint8Array, tsaUrl: string | null): Promise<{ cms: Uint8Array; timestamped: boolean }> {
  const base = buildSignedData(identity, { eContentType: OID.data, digest });
  if (!tsaUrl) return { cms: base.contentInfo, timestamped: false };
  try {
    const token = await requestTimestamp(tsaUrl, sha256(base.signature));
    const withTs = buildSignedData(identity, { eContentType: OID.data, digest, signature: base.signature, unsignedAttrs: [attr(OID.signatureTimeStampToken, token)] });
    return { cms: withTs.contentInfo, timestamped: true };
  } catch (e) {
    // The signature stays valid without a timestamp; the evidence log still records the time.
    log.warn("timestamp authority unavailable; signing without a trusted timestamp", { tsa: tsaUrl, error: (e as Error).message });
    return { cms: base.contentInfo, timestamped: false };
  }
}

class CadesSigner extends Signer {
  timestamped = false;
  private identity: SigningIdentity;
  private tsaUrl: string | null;
  constructor(identity: SigningIdentity, tsaUrl: string | null) {
    super();
    this.identity = identity;
    this.tsaUrl = tsaUrl;
  }
  async sign(pdfBuffer: Buffer): Promise<Buffer> {
    const { cms, timestamped } = await buildCadesSignature(this.identity, sha256(pdfBuffer), this.tsaUrl);
    this.timestamped = timestamped;
    return Buffer.from(cms);
  }
}

export interface PdfSignOptions {
  reason: string;
  location: string;
  name: string;
  contactInfo: string;
  signingTime: Date;
  tsaUrl: string | null;
}

/** Add a PAdES signature (invisible) to a finished PDF as an incremental update. */
export async function signPdf(pdf: Buffer, identity: SigningIdentity, opts: PdfSignOptions): Promise<{ pdf: Buffer; timestamped: boolean }> {
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: pdf,
    reason: opts.reason,
    location: opts.location,
    name: opts.name,
    contactInfo: opts.contactInfo,
    signingTime: opts.signingTime,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    signatureLength: 24_000,
    appName: "Signed.md",
  });
  const signer = new CadesSigner(identity, opts.tsaUrl);
  const signed = await new SignPdf().sign(withPlaceholder, signer);
  return { pdf: signed, timestamped: signer.timestamped };
}

const identities = new Map<string, SigningIdentity>();

/** The installation's PDF signing identity, created on first use. */
export function pdfIdentity(dataDir: string, accountName: string): SigningIdentity {
  let id = identities.get(dataDir);
  if (!id) {
    id = loadSigningIdentity(dataDir, accountName);
    identities.set(dataDir, id);
  }
  return id;
}

export function certificatePem(cert: X509Certificate): string {
  return cert.toString();
}
