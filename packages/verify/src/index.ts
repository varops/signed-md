import { type VerifyOptions, type VerifyReport, verifyPackageFiles } from "@signed-md/core/evidence";
import { unzipSync } from "fflate";

export type { VerifyReport, VerifyOptions };

/** Verify a completion package ZIP. Runs fully offline. */
export function verifyPackage(zip: Uint8Array, opts: VerifyOptions = {}): VerifyReport {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    return { ok: false, document_id: null, title: null, revision: null, key_id: null, trusted_key: false, signers: [], timestamp: null, pdf_signature: null, checks: [{ name: "readable ZIP", ok: false }] };
  }
  return verifyPackageFiles(files, opts);
}

/** Read trusted public keys from a keys file (/.well-known/signed-md-keys.json or a public-key.json). */
export function trustedKeysFrom(json: string): string[] {
  const data = JSON.parse(json) as { keys?: { public_key: string }[]; public_key?: string };
  if (Array.isArray(data.keys)) return data.keys.map((k) => k.public_key);
  if (typeof data.public_key === "string") return [data.public_key];
  throw new Error("Keys file has no public keys");
}
