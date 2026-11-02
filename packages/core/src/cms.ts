import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { der, type DerNode, derDecode, derDecodeValue, derTime, oidToString } from "./der.ts";

/** OIDs used by CMS, PAdES, and RFC 3161. */
export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
};

export interface CmsSignerInfo {
  certificate: X509Certificate;
  certificates: X509Certificate[];
  /** Digest from the messageDigest signed attribute. */
  messageDigest: Uint8Array;
  eContentType: string;
  /** Encapsulated content (for attached signatures such as timestamp tokens). */
  content: Uint8Array | null;
  signatureValue: Uint8Array;
  /** True when the signature over the signed attributes verifies with the certificate. */
  signatureValid: boolean;
  /** True when a signing-certificate(-v2) attribute matches the signer certificate (PAdES/CAdES). */
  signingCertificateBound: boolean;
  /** RFC 3161 timestamp token from the unsigned attributes, if any. */
  timestampToken: Uint8Array | null;
}

function sha256(b: Uint8Array): Uint8Array {
  return createHash("sha256").update(b).digest();
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Parse a CMS SignedData ContentInfo and verify its (single) signer's signature over the signed attributes. */
export function parseSignedData(contentInfo: Uint8Array): CmsSignerInfo {
  const ci = derDecode(contentInfo);
  if (oidToString(ci.children[0]!.value) !== OID.signedData) throw new Error("Not a CMS SignedData structure");
  const sd = ci.children[1]!.children[0]!;
  const parts = sd.children;
  const encap = parts[2]!;
  const eContentType = oidToString(encap.children[0]!.value);
  const content = encap.children[1] ? encap.children[1].children[0]!.value : null;
  const certificates: X509Certificate[] = [];
  let i = 3;
  if (parts[i] && parts[i]!.tag === 0xa0) {
    for (const c of parts[i]!.children) certificates.push(new X509Certificate(Buffer.from(c.raw)));
    i++;
  }
  if (parts[i] && parts[i]!.tag === 0xa1) i++; // CRLs
  const signerInfos = parts[i]!;
  const si = signerInfos.children[0]!;
  // SignerInfo: version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1] unsignedAttrs
  const sid = si.children[1]!;
  const signedAttrs = si.children[3]!;
  if (signedAttrs.tag !== 0xa0) throw new Error("Signed attributes are required");
  const sigAlg = oidToString(si.children[4]!.children[0]!.value);
  const signatureValue = si.children[5]!.value;
  const unsigned = si.children[6] && si.children[6].tag === 0xa1 ? si.children[6] : null;

  // Find the signer certificate by issuer and serial number.
  const serialHex = Buffer.from(sid.children[1]!.value).toString("hex").replace(/^(00)+/, "").toUpperCase();
  const certificate =
    certificates.find((c) => c.serialNumber.replace(/^(00)+/, "").toUpperCase() === serialHex) ?? certificates[0];
  if (!certificate) throw new Error("No signer certificate in the signature");

  const attrs = new Map<string, DerNode>();
  for (const a of signedAttrs.children) attrs.set(oidToString(a.children[0]!.value), a.children[1]!.children[0]!);
  const md = attrs.get(OID.messageDigest);
  if (!md) throw new Error("messageDigest attribute missing");

  // The signature is computed over the signed attributes encoded as a SET (tag 0x31), not [0].
  const toVerify = Buffer.from(signedAttrs.raw);
  toVerify[0] = 0x31;
  const key = createPublicKey(certificate.publicKey.export({ format: "pem", type: "spki" }));
  const algorithm = sigAlg === OID.rsaEncryption || sigAlg === OID.sha256WithRSA || sigAlg === OID.ecdsaWithSHA256 ? "sha256" : "sha256";
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(algorithm, toVerify, key, Buffer.from(signatureValue));
  } catch {
    signatureValid = false;
  }

  let signingCertificateBound = false;
  const scv2 = attrs.get(OID.signingCertificateV2);
  if (scv2) {
    const first = scv2.children[0]!.children[0]!; // certs -> ESSCertIDv2
    const hashNode = first.children.find((c) => c.tag === 0x04)!;
    signingCertificateBound = equal(hashNode.value, sha256(certificate.raw));
  }

  let timestampToken: Uint8Array | null = null;
  if (unsigned) {
    for (const a of unsigned.children) {
      if (oidToString(a.children[0]!.value) === OID.signatureTimeStampToken) timestampToken = a.children[1]!.children[0]!.raw;
    }
  }

  return { certificate, certificates, messageDigest: md.value, eContentType, content, signatureValue, signatureValid, signingCertificateBound, timestampToken };
}

export interface TimestampInfo {
  /** Time asserted by the timestamp authority. */
  genTime: Date;
  /** Hash the timestamp covers. */
  imprint: Uint8Array;
  /** Subject of the timestamp authority's certificate. */
  authority: string;
  /** Token signature verifies with the authority's certificate (integrity, not trust). */
  signatureValid: boolean;
}

/** Read and check an RFC 3161 TimeStampToken. Trust in the authority itself is up to the caller. */
export function parseTimestampToken(token: Uint8Array): TimestampInfo {
  const sd = parseSignedData(token);
  if (sd.eContentType !== OID.tstInfo || !sd.content) throw new Error("Not a timestamp token");
  const tst = derDecode(sd.content);
  // TSTInfo: version, policy, messageImprint, serialNumber, genTime, ...
  const imprint = tst.children[2]!.children[1]!.value;
  const genTime = derTime(tst.children[4]!);
  const contentOk = equal(sd.messageDigest, sha256(sd.content));
  return { genTime, imprint, authority: sd.certificate.subject.replace(/\n/g, ", "), signatureValid: sd.signatureValid && contentOk };
}

export { der, derDecode, derDecodeValue, oidToString };
