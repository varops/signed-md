import { createHash } from "node:crypto";
import type { Config } from "../config.ts";

/**
 * Avatars come from unavatar.io (AVATAR_PROVIDER=unavatar, the default) or Gravatar
 * (AVATAR_PROVIDER=gravatar), directly or through a CDN pull zone (UNAVATAR_DOMAIN, GRAVATAR_DOMAIN).
 * Only used when the account turns avatars on, because the lookup shares the email address
 * (Gravatar gets a SHA-256 hash of it).
 */
export function avatarUrl(config: Config, enabled: boolean, email: string | null | undefined, name?: string | null): string | null {
  if (!enabled || !email) return null;
  const address = email.trim().toLowerCase();
  const hash = createHash("sha256").update(address).digest();
  // Gravatar: d=404, so people without an account show initials.
  if (config.avatarProvider === "gravatar") return `${config.avatarBaseUrl}/${hash.toString("hex")}?d=404&s=128`;
  // unavatar: people without a picture get an initials image from ui-avatars.com, which unavatar
  // fetches and returns as a PNG. The colours come from the email's hash, so each person keeps
  // the same colours everywhere and links stay cacheable.
  const [background, color] = FALLBACK_COLOURS[hash[0]! % FALLBACK_COLOURS.length]!;
  const fallback = `https://ui-avatars.com/api/?${new URLSearchParams({ name: name?.trim() || address.split("@")[0]!, size: "128", background, color })}`;
  const token = config.unavatarToken ? `token=${encodeURIComponent(config.unavatarToken)}&` : "";
  return `${config.avatarBaseUrl}/${encodeURIComponent(address)}?${token}fallback=${encodeURIComponent(fallback)}`;
}

/** Background and text colour pairs for the initials images, all with readable contrast. */
const FALLBACK_COLOURS: [string, string][] = [
  ["0D8ABC", "fff"], ["2563EB", "fff"], ["4F46E5", "fff"], ["7C3AED", "fff"], ["9333EA", "fff"], ["C026D3", "fff"],
  ["DB2777", "fff"], ["DC2626", "fff"], ["C2410C", "fff"], ["15803D", "fff"], ["0F766E", "fff"], ["334155", "fff"],
  ["FDE68A", "78350F"], ["BBF7D0", "14532D"], ["BAE6FD", "0C4A6E"], ["FBCFE8", "831843"], ["DDD6FE", "4C1D95"], ["FED7AA", "7C2D12"],
];

const EMAIL_SAFE = /^image\/(png|jpe?g|gif)\b/i;
const CHECK_TTL_MS = 24 * 3600_000;
const checked = new Map<string, { url: string | null; until: number }>();

/**
 * The avatar for an email, or null to show initials. Email clients can't drop a broken image the
 * way the web UI does, so this checks once a day per address that a real avatar exists, in a
 * format Gmail and Outlook can show (not SVG or ICO).
 */
export async function emailAvatar(config: Config, enabled: boolean, email: string | null | undefined, name?: string | null): Promise<string | null> {
  const url = avatarUrl(config, enabled, email, name);
  if (!url) return null;
  const hit = checked.get(url);
  if (hit && hit.until > Date.now()) return hit.url;
  let ok = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    ok = res.ok && EMAIL_SAFE.test(res.headers.get("content-type") ?? "");
    await res.body?.cancel();
  } catch {
    ok = false;
  }
  checked.set(url, { url: ok ? url : null, until: Date.now() + CHECK_TTL_MS });
  return ok ? url : null;
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** The origin to allow in the Content-Security-Policy img-src. */
export function avatarOrigin(config: Config): string {
  return new URL(config.avatarBaseUrl).origin;
}
