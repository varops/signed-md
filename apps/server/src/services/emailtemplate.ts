/**
 * HTML email layout, modelled on familiar e-signature emails: logo, a dark banner with one clear
 * action, the sender's message, document details, and a security note.
 * Table-based with inline styles, because that is what email clients render reliably.
 */

const PRODUCT_URL = "https://signed.md";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const LOGO_CID = "logo@signed.md";

export interface Person {
  name: string;
  /** Avatar image URL, or null to show initials. */
  avatar: string | null;
  initials: string;
}

export interface EmailParts {
  account: string;
  /** "Powered by" link to signed.md in the footer. Off only on the hosted service's paid plans. Default on. */
  branding?: boolean;
  /** Banner background as #rrggbb. Text and button colours follow it. */
  bannerColor?: string;
  /** Show this person in the banner circle instead of the icon. */
  person?: Person;
  /** Signers shown with their avatars in the details. */
  signers?: Person[];
  /** True when a logo is attached inline as cid:logo@signed.md. */
  hasLogo: boolean;
  icon: "document" | "check" | "cross" | "clock" | "bell";
  /** Short headline inside the banner. Plain text. */
  headline: string;
  button?: { label: string; url: string };
  /** Sender block shown above the message. */
  from?: { name: string; email?: string };
  /** Custom message from the sender. Plain text; line breaks kept. */
  message?: string | null;
  /** Plain-text paragraphs below the message. */
  paragraphs?: string[];
  /** Small key-value table about the document. */
  details?: [string, string][];
  /** Show the "do not share this email" note (for emails with a personal signing link). */
  security?: boolean;
}

const ICONS: Record<EmailParts["icon"], { glyph: string; color: string }> = {
  document: { glyph: "&#9998;", color: "#f5b301" },
  check: { glyph: "&#10003;", color: "#22c55e" },
  cross: { glyph: "&#10005;", color: "#ef4444" },
  clock: { glyph: "&#9719;", color: "#f59e0b" },
  bell: { glyph: "&#9993;", color: "#f5b301" },
};

/** Relative luminance (WCAG) of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Blend a colour towards white (amount > 0) or black (amount < 0). Plain hex, so Outlook renders it. */
function shade(hex: string, amount: number): string {
  const t = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  return "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - a) + t * a).toString(16).padStart(2, "0")).join("");
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s);
}

/** Colours for text, the icon circle, and the button, chosen for contrast with the banner. */
export function bannerTheme(color: string) {
  const bg = isHexColor(color) ? color.toLowerCase() : "#1c1917";
  const light = luminance(bg) > 0.4;
  return {
    bg,
    text: light ? "#1c1917" : "#ffffff",
    circle: shade(bg, light ? -0.1 : 0.12),
    buttonBg: light ? "#1c1917" : "#f5b301",
    buttonText: light ? "#ffffff" : "#1c1917",
  };
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function avatarHtml(person: Person, size: number, circleBg: string, textColor: string): string {
  const r = Math.round(size / 2);
  if (person.avatar) {
    return `<img src="${esc(person.avatar)}" width="${size}" height="${size}" alt="${esc(person.name)}" style="display:block;width:${size}px;height:${size}px;border-radius:${r}px;border:0;margin:0 auto;object-fit:cover">`;
  }
  return `<div style="width:${size}px;height:${size}px;line-height:${size}px;border-radius:${r}px;background:${circleBg};color:${textColor};font:600 ${Math.round(size * 0.38)}px ${FONT};text-align:center;margin:0 auto">${esc(person.initials)}</div>`;
}

export function renderEmail(p: EmailParts): { html: string; text: string } {
  const icon = ICONS[p.icon];
  const theme = bannerTheme(p.bannerColor ?? "#1c1917");
  const badge = p.person
    ? avatarHtml(p.person, 64, theme.circle, theme.text)
    : `<div style="width:56px;height:56px;line-height:56px;border-radius:28px;background:${theme.circle};color:${icon.color};font:28px ${FONT};text-align:center;margin:0 auto">${icon.glyph}</div>`;
  const logo = p.hasLogo
    ? `<img src="cid:${LOGO_CID}" alt="${esc(p.account)}" height="40" style="display:block;height:40px;max-width:220px;border:0">`
    : `<span style="font:700 20px ${FONT};color:#1c1917">${esc(p.account)}</span>`;

  const button = p.button
    ? `<tr><td align="center" style="padding:6px 0 30px">
         <!--[if mso]><v:roundrect href="${esc(p.button.url)}" style="height:44px;v-text-anchor:middle;width:240px" arcsize="10%" fillcolor="${theme.buttonBg}" stroke="f"><center style="color:${theme.buttonText};font-family:Arial;font-size:14px;font-weight:bold">${esc(p.button.label.toUpperCase())}</center></v:roundrect><![endif]-->
         <!--[if !mso]><!--><a href="${esc(p.button.url)}" style="display:inline-block;background:${theme.buttonBg};color:${theme.buttonText};font:700 14px ${FONT};letter-spacing:.04em;text-decoration:none;padding:14px 28px;border-radius:4px">${esc(p.button.label.toUpperCase())}</a><!--<![endif]-->
       </td></tr>`
    : "";

  const from = p.from
    ? `<p style="margin:0 0 4px;font:700 15px ${FONT};color:#1c1917">${esc(p.from.name)}</p>${p.from.email ? `<p style="margin:0 0 16px;font:14px ${FONT};color:#78716c"><a href="mailto:${esc(p.from.email)}" style="color:#78716c;text-decoration:none">${esc(p.from.email)}</a></p>` : ""}`
    : "";
  const message = p.message
    ? `<p style="margin:0 0 18px;font:15px/1.6 ${FONT};color:#1c1917">${esc(p.message).replace(/\n/g, "<br>")}</p>`
    : "";
  const paragraphs = (p.paragraphs ?? []).map((x) => `<p style="margin:0 0 14px;font:15px/1.6 ${FONT};color:#1c1917">${esc(x)}</p>`).join("");
  const signersRow = p.signers?.length
    ? `<tr><td style="padding:10px 12px 10px 0;font:13px ${FONT};color:#78716c;white-space:nowrap;vertical-align:top;border-bottom:1px solid #e7e5e4">Signers</td><td style="padding:6px 0;border-bottom:1px solid #e7e5e4">${p.signers
        .map(
          (s) => `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:2px 14px 2px 0"><tr><td style="padding-right:8px">${avatarHtml(s, 24, "#e7e5e4", "#57534e")}</td><td style="font:14px ${FONT};color:#1c1917;white-space:nowrap">${esc(s.name)}</td></tr></table>`,
        )
        .join("")}</td></tr>`
    : "";
  const details = p.details?.length || signersRow
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border-top:1px solid #e7e5e4">${(p.details ?? [])
        .map(([k, v]) => `<tr><td style="padding:10px 12px 10px 0;font:13px ${FONT};color:#78716c;white-space:nowrap;vertical-align:top;border-bottom:1px solid #e7e5e4">${esc(k)}</td><td style="padding:10px 0;font:14px ${FONT};color:#1c1917;border-bottom:1px solid #e7e5e4">${esc(v)}</td></tr>`)
        .join("")}${signersRow}</table>`
    : "";
  const security = p.security
    ? `<tr><td style="padding:22px 36px 0"><p style="margin:0 0 6px;font:700 13px ${FONT};color:#1c1917">Do not share this email</p>
        <p style="margin:0;font:13px/1.55 ${FONT};color:#57534e">This email contains a secure link to your document. Please don't share it or forward it. Anyone with the link can view the document and act on your behalf.</p></td></tr>`
    : "";

  const byline = p.branding === false
    ? `Sent by ${esc(p.account)}. `
    : `Sent by ${esc(p.account)} with <a href="${PRODUCT_URL}" style="color:#a8a29e;text-decoration:underline">Signed.md</a>, open-source electronic signatures. `;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(p.headline)}</title></head>
<body style="margin:0;padding:0;background:#f2f1ef">
<div style="display:none;max-height:0;overflow:hidden">${esc(p.headline)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ef"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:6px;overflow:hidden">
    <tr><td style="padding:26px 36px 22px">${logo}</td></tr>
    <tr><td style="padding:0 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${theme.bg};border-radius:4px" bgcolor="${theme.bg}">
        <tr><td align="center" style="padding:34px 28px 10px">${badge}</td></tr>
        <tr><td align="center" style="padding:10px 28px 26px;font:400 19px/1.45 ${FONT};color:${theme.text}">${esc(p.headline)}</td></tr>
        ${button}
      </table>
    </td></tr>
    <tr><td style="padding:28px 36px 6px">${from}${message}${paragraphs}${details}</td></tr>
    ${security}
    <tr><td style="padding:26px 36px 30px"><p style="margin:0;font:12px/1.5 ${FONT};color:#a8a29e">${byline}If you weren't expecting this email, you can ignore it.</p></td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    p.headline,
    p.button ? `\n${p.button.label}: ${p.button.url}` : "",
    p.from ? `\nFrom: ${p.from.name}${p.from.email ? ` <${p.from.email}>` : ""}` : "",
    p.message ? `\n${p.message}` : "",
    ...(p.paragraphs ?? []).map((x) => `\n${x}`),
    p.details?.length ? "\n" + p.details.map(([k, v]) => `${k}: ${v}`).join("\n") : "",
    p.signers?.length ? `Signers: ${p.signers.map((x) => x.name).join(", ")}` : "",
    p.security ? "\nDo not share this email. It contains a secure link to your document." : "",
    p.branding === false ? `\n--\nSent by ${p.account}.` : `\n--\nSent by ${p.account} with Signed.md (${PRODUCT_URL}).`,
  ]
    .filter(Boolean)
    .join("\n");
  return { html, text };
}
