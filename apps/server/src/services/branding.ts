import { SignedError } from "@signed-md/core";
import type { Actor, Ctx } from "../context.ts";
import { requirePermission } from "./permissions.ts";
import { CONTRACT_FONT_NAMES, isContractFont } from "./fonts.ts";
import { sha256 } from "../crypto.ts";
import { getAccount, updateAccount } from "./accounts.ts";
import { checkMessageVariables } from "./messagevars.ts";

const MAX_LOGO_BYTES = 300_000;

/** PNG or JPEG only: they work in every email client, and unlike SVG they cannot carry scripts. */
function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export async function setLogo(ctx: Ctx, actor: Actor, bytes: Uint8Array): Promise<void> {
  requirePermission(actor, "settings.manage");
  if (bytes.length === 0) throw new SignedError("INVALID_REQUEST", "Choose a logo file to upload");
  if (bytes.length > MAX_LOGO_BYTES) throw new SignedError("INVALID_REQUEST", "The logo must be at most 300 KB");
  const type = sniff(bytes);
  if (!type) throw new SignedError("INVALID_REQUEST", "The logo must be a PNG or JPEG image");
  const hash = sha256(bytes);
  // Each logo gets its own file. Old files are kept, never deleted.
  const path = `branding/logo-${hash.slice(0, 16)}.${type === "image/png" ? "png" : "jpg"}`;
  await ctx.storage.write(path, bytes);
  const account = await getAccount(ctx);
  await updateAccount(ctx, actor, { config: { branding: { ...account.config.branding, logo: { path, content_type: type, sha256: hash } } } });
}

export async function removeLogo(ctx: Ctx, actor: Actor): Promise<void> {
  const account = await getAccount(ctx);
  await updateAccount(ctx, actor, { config: { branding: { ...account.config.branding, logo: null } } });
}

export async function setDefaultMessage(ctx: Ctx, actor: Actor, message: string): Promise<void> {
  if (message.length > 2000) throw new SignedError("INVALID_REQUEST", "The message must be at most 2000 characters");
  checkMessageVariables(message);
  const account = await getAccount(ctx);
  await updateAccount(ctx, actor, { config: { branding: { ...account.config.branding, email_message: message.trim() } } });
}

export async function setBannerAndAvatars(ctx: Ctx, actor: Actor, input: { banner_color: string; avatars: boolean }): Promise<void> {
  const color = input.banner_color.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new SignedError("INVALID_REQUEST", "The banner colour must be a hex colour like #1c1917");
  const account = await getAccount(ctx);
  await updateAccount(ctx, actor, { config: { branding: { ...account.config.branding, banner_color: color, avatars: input.avatars } } });
}

export async function setContractFont(ctx: Ctx, actor: Actor, font: string): Promise<void> {
  if (!isContractFont(font)) throw new SignedError("INVALID_REQUEST", `Font must be one of: ${CONTRACT_FONT_NAMES.join(", ")}`);
  const account = await getAccount(ctx);
  await updateAccount(ctx, actor, { config: { branding: { ...account.config.branding, contract_font: font } } });
}

export async function readLogo(ctx: Ctx): Promise<{ data: Buffer; contentType: string; sha256: string } | null> {
  const logo = (await getAccount(ctx)).config.branding.logo;
  if (!logo) return null;
  const data = await ctx.storage.read(logo.path).catch(() => null);
  return data ? { data, contentType: logo.content_type, sha256: logo.sha256 } : null;
}
