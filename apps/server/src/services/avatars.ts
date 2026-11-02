import type { Config } from "../config.ts";

/**
 * Avatars come from unavatar.io (or a CDN pull zone in front of it, via AVATAR_BASE_URL).
 * Only used when the account turns avatars on, because the lookup shares the email address.
 */
export function avatarUrl(config: Config, enabled: boolean, email: string | null | undefined): string | null {
  if (!enabled || !email) return null;
  return `${config.avatarBaseUrl}/${encodeURIComponent(email.trim().toLowerCase())}`;
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
