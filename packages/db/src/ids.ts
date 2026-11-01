import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase.

/** Random, URL-safe, prefixed ID such as "doc_7k2m9q4x8r1t5v3w0z6y". 100 bits of entropy. */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i]! & 31];
  return `${prefix}_${out}`;
}

/** Current time as ISO 8601 UTC with milliseconds. Sorts correctly as text. */
export function now(): string {
  return new Date().toISOString();
}
