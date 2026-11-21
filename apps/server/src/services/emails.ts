import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAwaitingSigner, isOpenStatus, reminderLabel, SignedError } from "@signed-md/core";
import type { Ctx } from "../context.ts";
import { unseal } from "../crypto.ts";
import { getAccount } from "./accounts.ts";
import { readLogo } from "./branding.ts";
import { loadDocument, loadSigners } from "./documents.ts";
import { BRAND_CID, type EmailParts, LOGO_CID, type Person, renderEmail } from "./emailtemplate.ts";
import { emailAvatar, initialsOf } from "./avatars.ts";
import { downloadLink, slug } from "./finalize.ts";
import type { MailAttachment, MailMessage } from "./mail.ts";
import { personalizeMessage } from "./messagevars.ts";

export interface EmailJob {
  kind: "signing_request" | "reminder" | "last_signer" | "revoked" | "declined" | "expired" | "completed" | "completed_sender" | "invitation" | "password_reset";
  document_id?: string;
  invitation_id?: string;
  reset_id?: string;
  signer_id?: string;
  link?: string;
  /** Reminders: which one this is (1 = first), for the subject. */
  reminder?: number;
  /** Reminders: true when the email carries a new link (a manual resend). Automatic ones reuse the link. */
  new_link?: boolean;
  /** A reminder before the deadline: 24 or 1. */
  expires_in_hours?: number;
}

async function adminEmails(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.selectFrom("users").select("email").where("status", "=", "active").where("role", "in", ["owner", "admin"]).execute();
  return rows.map((r) => r.email);
}

/** Out for signature and not past its deadline: only then do signing emails still make sense. */
function stillSigning(doc: { status: Parameters<typeof isOpenStatus>[0]; expires_at: string | null }): boolean {
  return isOpenStatus(doc.status) && !(doc.expires_at !== null && doc.expires_at < new Date().toISOString());
}

function longDate(iso: string | null, tz: string): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: tz }).format(new Date(iso));
}

function longDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "short" }).format(new Date(iso));
}

/** The small Signed.md logo for the footer, while "Powered by Signed.md" is on. */
const BRAND_PNG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "email-footer-logo.png"));
export function brandAttachment(ctx: Ctx): MailAttachment[] {
  return ctx.config.branding ? [{ filename: "signed-md.png", content: BRAND_PNG, contentType: "image/png", cid: BRAND_CID }] : [];
}

async function emailAssets(ctx: Ctx) {
  const account = await getAccount(ctx);
  const logo = await readLogo(ctx);
  const inline: MailAttachment[] = [...(logo ? [{ filename: `logo.${logo.contentType === "image/png" ? "png" : "jpg"}`, content: logo.data, contentType: logo.contentType, cid: LOGO_CID }] : []), ...brandAttachment(ctx)];
  return { account, logo, inline };
}

async function sendInvitation(ctx: Ctx, job: EmailJob): Promise<void> {
  const inv = await ctx.db.selectFrom("invitations").selectAll().where("id", "=", job.invitation_id!).executeTakeFirst();
  if (!inv || inv.accepted_at || inv.revoked_at || !job.link) return;
  const inviter = await ctx.db.selectFrom("users").select(["name", "email"]).where("id", "=", inv.invited_by).executeTakeFirst();
  const { account, logo, inline } = await emailAssets(ctx);
  const inviterName = inviter ? inviter.name || inviter.email : account.name;
  const role = { owner: "an owner", admin: "an administrator", member: "a member", viewer: "a viewer" }[inv.role];
  const { html, text } = renderEmail({
    account: account.name,
    branding: ctx.config.branding,
    hasLogo: logo !== null,
    bannerColor: account.config.branding.banner_color,
    icon: "bell",
    person: { name: inviterName, avatar: await emailAvatar(ctx.config, account.config.branding.avatars, inviter?.email, inviterName), initials: initialsOf(inviterName) },
    headline: `${inviterName} invited you to join ${account.name} on Signed.md.`,
    button: { label: "Accept invitation", url: unseal(ctx.keys.serverSecret, job.link) },
    paragraphs: [`You'll join as ${role}. Signed.md is where ${account.name} prepares and sends agreements for signature.`, "The invitation expires in 7 days."],
    security: true,
  });
  await ctx.mailer.send({ to: inv.email, subject: `Join ${account.name} on Signed.md`, html, text, ...(inviter ? { replyTo: inviter.email } : {}), attachments: inline });
}

async function sendPasswordReset(ctx: Ctx, job: EmailJob): Promise<void> {
  const reset = await ctx.db
    .selectFrom("password_resets")
    .innerJoin("users", "users.id", "password_resets.user_id")
    .select(["password_resets.used_at", "password_resets.expires_at", "users.email", "users.name"])
    .where("password_resets.id", "=", job.reset_id!)
    .executeTakeFirst();
  // Don't send a link that has already been used, replaced or has run out.
  if (!reset || reset.used_at || reset.expires_at < new Date().toISOString() || !job.link) return;
  const { account, logo, inline } = await emailAssets(ctx);
  const { html, text } = renderEmail({
    account: account.name,
    branding: ctx.config.branding,
    hasLogo: logo !== null,
    bannerColor: account.config.branding.banner_color,
    icon: "bell",
    headline: "Reset your Signed.md password",
    button: { label: "Choose a new password", url: unseal(ctx.keys.serverSecret, job.link) },
    paragraphs: [
      `Someone asked to reset the password for ${reset.email} at ${account.name}. If it was you, use the button to choose a new one.`,
      "The link works once and expires in 1 hour.",
      "If you didn't ask for this, you can ignore this email. Your password stays the same.",
    ],
    security: true,
  });
  await ctx.mailer.send({ to: reset.email, subject: "Reset your Signed.md password", html, text, attachments: inline });
}

/** Build and send the messages for one email job. */
export async function sendEmailJob(ctx: Ctx, job: EmailJob): Promise<void> {
  if (job.kind === "invitation") return sendInvitation(ctx, job);
  if (job.kind === "password_reset") return sendPasswordReset(ctx, job);
  const account = await getAccount(ctx);
  const doc = await loadDocument(ctx.db, job.document_id!);
  const signers = await loadSigners(ctx.db, doc.id);
  const signer = job.signer_id ? signers.find((s) => s.id === job.signer_id) : undefined;
  if (job.signer_id && !signer) throw new SignedError("SIGNER_INVALID", `Signer ${job.signer_id} not found`);

  // The document's owner is the sender: signers see their name, avatar, and email, and replies go to them.
  // Notices (declined, expired, completed) go to the owner, or to the owners of the account if theirs is inactive.
  const owner = doc.owner_user_id
    ? await ctx.db.selectFrom("users").select(["name", "email", "status"]).where("id", "=", doc.owner_user_id).executeTakeFirst()
    : undefined;
  const admins = owner?.status === "active" ? [owner.email] : await adminEmails(ctx);
  const senderEmail = owner?.email ?? admins[0];
  const senderName = owner ? owner.name || owner.email.split("@")[0]! : account.name;
  const logo = await readLogo(ctx);
  const inline: MailAttachment[] = [...(logo ? [{ filename: `logo.${logo.contentType === "image/png" ? "png" : "jpg"}`, content: logo.data, contentType: logo.contentType, cid: LOGO_CID }] : []), ...brandAttachment(ctx)];
  const docUrl = `${ctx.config.publicUrl}/documents/${doc.id}`;
  const messages: MailMessage[] = [];

  const branding = account.config.branding;
  const person = async (name: string, email: string | null | undefined): Promise<Person> => ({ name, avatar: await emailAvatar(ctx.config, branding.avatars, email, name), initials: initialsOf(name) });
  const sender = await person(senderName, senderEmail);
  const signerPeople = await Promise.all(signers.map((s) => person(s.name, s.email)));

  const msg = (to: string, subject: string, parts: Omit<EmailParts, "account" | "hasLogo">, attachments: MailAttachment[] = []) => {
    const { html, text } = renderEmail({ account: account.name, branding: ctx.config.branding, hasLogo: logo !== null, bannerColor: branding.banner_color, ...parts });
    messages.push({ to, subject, html, text, ...(senderEmail ? { replyTo: senderEmail } : {}), attachments: [...inline, ...attachments] });
  };

  const artifacts = async (withZip: boolean) => {
    const rows = await ctx.db.selectFrom("artifacts").selectAll().where("document_id", "=", doc.id).execute();
    const files: MailAttachment[] = [];
    let pdfId: string | null = null;
    for (const a of rows) {
      if (a.type === "pdf") {
        pdfId = a.id;
        files.push({ filename: `${slug(doc.title)}.pdf`, content: await ctx.storage.read(a.storage_path), contentType: "application/pdf" });
      }
      if (a.type === "zip" && withZip && Number(a.size) < 10_000_000) {
        files.push({ filename: `${slug(doc.title)}.zip`, content: await ctx.storage.read(a.storage_path), contentType: "application/zip" });
      }
    }
    return { files, pdfId };
  };

  switch (job.kind) {
    case "signing_request":
    case "reminder": {
      if (!signer || !job.link) throw new Error("signing email without signer or link");
      // Do not send stale links: the signer may have signed, or the document may be closed or past its deadline.
      if (!stillSigning(doc) || !isAwaitingSigner(signer.status)) return;
      // A newer link replaced this one (a manual resend): its own email carries the working link.
      if (signer.link_sealed && signer.link_sealed !== job.link) return;
      const link = unseal(ctx.keys.serverSecret, job.link);
      const reminder = job.kind === "reminder";
      // Jobs queued before numbered reminders existed were manual resends with a new link.
      const newLink = reminder && job.new_link !== false;
      const hours = reminder && doc.expires_at ? job.expires_in_hours : undefined;
      const left = hours === undefined ? "" : hours === 1 ? "1 hour" : `${hours} hours`;
      const subject = reminder
        ? `${reminderLabel(job.reminder ?? 1)}: Please sign: ${doc.title}${left ? ` – expires in ${left}` : ""}`
        : `Please sign: ${doc.title}`;
      msg(signer.email, subject, {
        icon: "document",
        person: sender,
        headline: `${senderName} sent you a document to review and sign.`,
        button: { label: "Review document", url: link },
        from: { name: owner ? `${senderName} · ${account.name}` : account.name, ...(senderEmail ? { email: senderEmail } : {}) },
        message: doc.signer_message ? personalizeMessage(doc.signer_message, { name: signer.name, email: signer.email, title: doc.title }) : null,
        // The sender's message replaces the standard line, as in familiar e-signature emails.
        paragraphs: [
          ...(doc.signer_message ? [] : [`Hi ${signer.name}, please review and sign "${doc.title}". It takes a few minutes and works on your phone.`]),
          ...(left ? [`This document expires in about ${left}, on ${longDateTime(doc.expires_at!, doc.timezone)}. After that it can no longer be signed.`] : []),
          ...(newLink ? ["This is a new link. Any earlier link for this document no longer works."] : []),
        ],
        signers: signerPeople,
        details: [
          ["Document", doc.title],
          ...(doc.expires_at ? ([["Please sign by", longDate(doc.expires_at, doc.timezone)]] as [string, string][]) : []),
        ],
        security: true,
      });
      break;
    }
    case "last_signer": {
      if (!signer || !isAwaitingSigner(signer.status) || !stillSigning(doc)) return;
      // The signer's link is kept sealed, so this email can carry it. Older documents have none.
      const link = signer.link_sealed ? unseal(ctx.keys.serverSecret, signer.link_sealed) : null;
      msg(signer.email, `Waiting for you: ${doc.title}`, {
        icon: "bell",
        person: sender,
        headline: `Everyone else has signed. Only your signature is missing.`,
        ...(link ? { button: { label: "Review document", url: link } } : {}),
        paragraphs: [
          `Hi ${signer.name},`,
          link
            ? `Everyone else has signed "${doc.title}". It's the same link as in the earlier email from ${account.name}.`
            : `Everyone else has signed "${doc.title}". Please use the "Review document" link in the earlier email from ${account.name}. If you can't find it, reply to this email and ask for a new link.`,
        ],
        ...(link ? { security: true } : {}),
        details: [["Document", doc.title], ...(doc.expires_at ? ([["Please sign by", longDate(doc.expires_at, doc.timezone)]] as [string, string][]) : [])],
      });
      break;
    }
    case "revoked": {
      if (!signer) return;
      msg(signer.email, `Cancelled: ${doc.title}`, {
        icon: "cross",
        person: sender,
        headline: `${senderName} cancelled this document.`,
        paragraphs: [`Hi ${signer.name},`, `"${doc.title}" was cancelled. You don't need to do anything, and the signing link no longer works.`],
        details: [["Document", doc.title]],
      });
      break;
    }
    case "declined": {
      for (const to of admins) {
        msg(to, `Declined: ${doc.title}`, {
          icon: "cross",
          ...(signer ? { person: await person(signer.name, signer.email) } : {}),
          headline: `${signer?.name ?? "A signer"} declined to sign.`,
          button: { label: "View document", url: docUrl },
          paragraphs: [signer?.decline_reason ? `Their reason: "${signer.decline_reason}"` : "They didn't give a reason."],
          details: [["Document", doc.title], ["Declined by", signer ? `${signer.name} (${signer.email})` : "–"]],
        });
      }
      break;
    }
    case "expired": {
      for (const to of admins) {
        msg(to, `Expired: ${doc.title}`, {
          icon: "clock",
          headline: "This document expired before everyone signed.",
          button: { label: "View document", url: docUrl },
          signers: signerPeople,
          details: [["Document", doc.title]],
        });
      }
      break;
    }
    case "completed": {
      if (!signer) return;
      const { files, pdfId } = await artifacts(account.config.attach_zip);
      msg(
        signer.email,
        `Completed: ${doc.title}`,
        {
          icon: "check",
          headline: "Your document has been completed.",
          ...(pdfId ? { button: { label: "View completed document", url: downloadLink(ctx, pdfId, 30 * 86400).url } } : {}),
          paragraphs: [`Hi ${signer.name},`, `Everyone has signed "${doc.title}". A copy is attached to this email for your records.`],
          signers: signerPeople,
            details: [["Document", doc.title], ["Completed", longDate(doc.completed_at, doc.timezone)]],
        },
        files,
      );
      break;
    }
    case "completed_sender": {
      const { files } = await artifacts(account.config.attach_zip);
      for (const to of admins) {
        msg(
          to,
          `Completed: ${doc.title}`,
          {
            icon: "check",
            headline: "All parties have completed the document.",
            button: { label: "View document", url: docUrl },
            paragraphs: ["The signed PDF is attached. The full evidence package is in Signed.md."],
            signers: signerPeople,
            details: [["Document", doc.title], ["Completed", longDate(doc.completed_at, doc.timezone)]],
          },
          files,
        );
      }
      break;
    }
  }

  for (const m of messages) await ctx.mailer.send(m);
}
