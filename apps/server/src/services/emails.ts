import { SignedError } from "@signed-md/core";
import type { Ctx } from "../context.ts";
import { unseal } from "../crypto.ts";
import { getAccount } from "./accounts.ts";
import { readLogo } from "./branding.ts";
import { loadDocument, loadSigners } from "./documents.ts";
import { type EmailParts, LOGO_CID, renderEmail } from "./emailtemplate.ts";
import { downloadLink, slug } from "./finalize.ts";
import type { MailAttachment, MailMessage } from "./mail.ts";
import { personalizeMessage } from "./messagevars.ts";

export interface EmailJob {
  kind: "signing_request" | "reminder" | "last_signer" | "revoked" | "declined" | "expired" | "completed" | "completed_sender";
  document_id: string;
  signer_id?: string;
  link?: string;
}

async function adminEmails(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.selectFrom("users").select("email").where("status", "=", "active").execute();
  return rows.map((r) => r.email);
}

function longDate(iso: string | null, tz: string): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: tz }).format(new Date(iso));
}

/** Build and send the messages for one email job. */
export async function sendEmailJob(ctx: Ctx, job: EmailJob): Promise<void> {
  const account = await getAccount(ctx);
  const doc = await loadDocument(ctx.db, job.document_id);
  const signers = await loadSigners(ctx.db, doc.id);
  const signer = job.signer_id ? signers.find((s) => s.id === job.signer_id) : undefined;
  if (job.signer_id && !signer) throw new SignedError("SIGNER_INVALID", `Signer ${job.signer_id} not found`);

  const admins = await adminEmails(ctx);
  const senderEmail = admins[0];
  const logo = await readLogo(ctx);
  const inline: MailAttachment[] = logo ? [{ filename: `logo.${logo.contentType === "image/png" ? "png" : "jpg"}`, content: logo.data, contentType: logo.contentType, cid: LOGO_CID }] : [];
  const docUrl = `${ctx.config.publicUrl}/documents/${doc.id}`;
  const messages: MailMessage[] = [];

  const msg = (to: string, subject: string, parts: Omit<EmailParts, "account" | "hasLogo">, attachments: MailAttachment[] = []) => {
    const { html, text } = renderEmail({ account: account.name, hasLogo: logo !== null, ...parts });
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

  const signerNames = signers.map((s) => s.name).join(", ");

  switch (job.kind) {
    case "signing_request":
    case "reminder": {
      if (!signer || !job.link) throw new Error("signing email without signer or link");
      // Do not send stale links: the signer may have signed, or the document may be closed.
      if (!["sent", "partially_signed"].includes(doc.status) || signer.status === "signed" || signer.status === "declined") return;
      const link = unseal(ctx.keys.serverSecret, job.link);
      const reminder = job.kind === "reminder";
      msg(signer.email, `${reminder ? "Reminder: " : ""}Please sign: ${doc.title}`, {
        icon: "document",
        headline: `${account.name} sent you a document to review and sign.`,
        button: { label: "Review document", url: link },
        from: { name: account.name, ...(senderEmail ? { email: senderEmail } : {}) },
        message: doc.signer_message ? personalizeMessage(doc.signer_message, { name: signer.name, email: signer.email, title: doc.title }) : null,
        // The sender's message replaces the standard line, as in familiar e-signature emails.
        paragraphs: [
          ...(doc.signer_message ? [] : [`Hi ${signer.name}, please review and sign "${doc.title}". It takes a few minutes and works on your phone.`]),
          ...(reminder ? ["This is a new link. Any earlier link for this document no longer works."] : []),
        ],
        details: [
          ["Document", doc.title],
          ["Signers", signerNames],
          ...(doc.expires_at ? ([["Please sign by", longDate(doc.expires_at, doc.timezone)]] as [string, string][]) : []),
        ],
        security: true,
      });
      break;
    }
    case "last_signer": {
      if (!signer || signer.status === "signed" || !["sent", "partially_signed"].includes(doc.status)) return;
      msg(signer.email, `Waiting for you: ${doc.title}`, {
        icon: "bell",
        headline: `Everyone else has signed. Only your signature is missing.`,
        paragraphs: [
          `Hi ${signer.name},`,
          `Everyone else has signed "${doc.title}". Please use the "Review document" link in the earlier email from ${account.name}. If you can't find it, reply to this email and ask for a new link.`,
        ],
        details: [["Document", doc.title], ...(doc.expires_at ? ([["Please sign by", longDate(doc.expires_at, doc.timezone)]] as [string, string][]) : [])],
      });
      break;
    }
    case "revoked": {
      if (!signer) return;
      msg(signer.email, `Cancelled: ${doc.title}`, {
        icon: "cross",
        headline: `${account.name} cancelled this document.`,
        paragraphs: [`Hi ${signer.name},`, `"${doc.title}" was cancelled. You don't need to do anything, and the signing link no longer works.`],
        details: [["Document", doc.title]],
      });
      break;
    }
    case "declined": {
      for (const to of admins) {
        msg(to, `Declined: ${doc.title}`, {
          icon: "cross",
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
          details: [["Document", doc.title], ["Signers", signerNames]],
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
          details: [["Document", doc.title], ["Signers", signerNames], ["Completed", longDate(doc.completed_at, doc.timezone)]],
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
            details: [["Document", doc.title], ["Signers", signerNames], ["Completed", longDate(doc.completed_at, doc.timezone)]],
          },
          files,
        );
      }
      break;
    }
  }

  for (const m of messages) await ctx.mailer.send(m, account.config.smtp);
}
