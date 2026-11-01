import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./crypto.ts";

export interface PublicKeyInfo {
  /** Stable key ID derived from the public key. */
  kid: string;
  alg: "Ed25519";
  /** SPKI DER public key, base64. */
  public_key: string;
  /** Same key as PEM, for openssl. */
  public_key_pem: string;
  created_at: string;
}

/**
 * Installation keys, stored in DATA_DIR/keys. Back these up with the database.
 * - signing-key.pem: Ed25519 key that signs package manifests.
 * - server-secret: random secret for signed download URLs and CSRF tokens.
 */
export class Keys {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly info: PublicKeyInfo;
  readonly serverSecret: Buffer;

  constructor(dataDir: string) {
    const dir = join(dataDir, "keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const keyPath = join(dir, "signing-key.pem");
    const metaPath = join(dir, "signing-key.json");
    if (!existsSync(keyPath)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      writeFileSync(metaPath, JSON.stringify({ created_at: new Date().toISOString() }));
    }
    this.privateKey = createPrivateKey(readFileSync(keyPath));
    this.publicKey = createPublicKey(this.privateKey);
    const der = this.publicKey.export({ type: "spki", format: "der" });
    const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as { created_at: string }) : { created_at: "" };
    this.info = {
      kid: `smdk_${sha256(der).slice(0, 16)}`,
      alg: "Ed25519",
      public_key: der.toString("base64"),
      public_key_pem: this.publicKey.export({ type: "spki", format: "pem" }).toString(),
      created_at: meta.created_at,
    };

    const secretPath = join(dir, "server-secret");
    if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.serverSecret = Buffer.from(readFileSync(secretPath, "utf8").trim(), "hex");
  }

  sign(data: string | Uint8Array): string {
    return sign(null, Buffer.from(data), this.privateKey).toString("base64");
  }

  verify(data: string | Uint8Array, signature: string): boolean {
    return verify(null, Buffer.from(data), this.publicKey, Buffer.from(signature, "base64"));
  }
}
