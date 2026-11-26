import { randomBytes } from "node:crypto";
import { der, derDecode } from "@signed-md/core/der";
import { OID, parseTimestampToken } from "@signed-md/core/cms";

/**
 * RFC 3161 timestamp client. Only a SHA-256 hash leaves the server, never the document.
 * Returns the TimeStampToken (a CMS ContentInfo) or throws.
 */
export async function requestTimestamp(url: string, hash: Uint8Array, timeoutMs = 15_000): Promise<Uint8Array> {
  const nonce = randomBytes(8);
  nonce[0]! &= 0x7f;
  const req = der.seq(
    der.int(1),
    der.seq(der.seq(der.oid(OID.sha256), der.null()), der.octet(hash)),
    der.int(nonce),
    der.bool(true),
  );
  const { fetch } = await import("./undici.ts");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
    body: req,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Timestamp authority returned HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const resp = derDecode(body);
  const status = Number(resp.children[0]!.children[0]!.value[0]);
  if (status !== 0 && status !== 1) throw new Error(`Timestamp authority refused the request (status ${status})`);
  const token = resp.children[1];
  if (!token) throw new Error("Timestamp authority returned no token");
  const info = parseTimestampToken(token.raw);
  if (!Buffer.from(info.imprint).equals(Buffer.from(hash))) throw new Error("Timestamp token covers a different hash");
  if (!info.signatureValid) throw new Error("Timestamp token signature does not verify");
  return new Uint8Array(token.raw);
}
