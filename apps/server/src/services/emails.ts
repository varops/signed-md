import { SignedError } from "@signed-md/core";
import type { Ctx } from "../context.ts";
import { unseal } from "../crypto.ts";
import { getAccount } from "./accounts.ts";
import { loadDocument, loadSigners } from "./documents.ts";
import { slug } from "./finalize.ts";
import type { MailAttachment, MailMessage } from "./mail.ts";

export interface EmailJob {
  kind: "signing_request" | "reminder" | "last_signer" | "revoked" | "declined" | "expired" | "completed" | "completed_sender";
  document_id: string;
  signer_id?: string;
  link?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(account: string, paragraphs: string[], button?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("");
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600">${esc(button.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#666">Or open this link: <br><span style="word-break:break-all">${esc(button.url)}</span></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px">
${body}${btn}
<p style="margin:24px 0 0;font-size:12px;color:#888">Sent by ${esc(account)} with Signed.md.</p>
</div></body></html>`;
}

async function adminEmails(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.selectFrom("users").select("email").where("status", "=", "active").execute();
  return rows.map((r) => r.email);
}

/** Build and send the messages for one email job. */
export async function sendEmailJob(ctx: Ctx, job: EmailJob): Promise<void> {
  const account = await getAccount(ctx);
  const doc = await loadDocument(ctx.db, job.document_id);
  const signers = await loadSigners(ctx.db, doc.id);
  const signer = job.signer_id ? signers.find((s) => s.id === job.signer_id) : undefined;
  if (job.signer_id && !signer) throw new SignedError("SIGNER_INVALID", `Signer ${job.signer_id} not found`);
  const title = esc(doc.title);
  const from = esc(account.name);
  const messages: MailMessage[] = [];

  const plain = (html: string) => html.replace(/<br>/g, "\n").replace(/<\/p>/g, "\n\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
  const msg = (to: string, subject: string, paragraphs: string[], button?: { label: string; url: string }, attachments?: MailAttachment[]) => {
    const html = layout(account.name, paragraphs, button);
    const text = plain(paragraphs.join("</p>")) + (button ? `\n\n${button.label}: ${button.url}` : "");
    messages.push({ to, subject, html, text, ...(attachments ? { attachments } : {}) });
  };

  const attachments = async (withZip: boolean): Promise<MailAttachment[]> => {
    const rows = await ctx.db.selectFrom("artifacts").selectAll().where("document_id", "=", doc.id).execute();
    const out: MailAttachment[] = [];
    for (const a of rows) {
      if (a.type === "pdf") out.push({ filename: `${slug(doc.title)}.pdf`, content: await ctx.storage.read(a.storage_path), contentType: "application/pdf" });
      if (a.type === "zip" && withZip && Number(a.size) < 10_000_000) {
        out.push({ filename: `${slug(doc.title)}.zip`, content: await ctx.storage.read(a.storage_path), contentType: "application/zip" });
      }
    }
    return out;
  };

  switch (job.kind) {
    case "signing_request":
    case "reminder": {
      if (!signer || !job.link) throw new Error("signing email without signer or link");
      // Do not send stale links: the signer may have signed, or the document may be closed.
      if (!["sent", "partially_signed"].includes(doc.status) || signer.status === "signed" || signer.status === "declined") return;
      const link = unseal(ctx.keys.serverSecret, job.link);
      const reminder = job.kind === "reminder";
      msg(
        signer.email,
        `${reminder ? "Reminder: " : ""}${account.name} sent you "${doc.title}" to sign`,
        [
          `Hi ${esc(signer.name)},`,
          `${from} asks you to review and sign <strong>${title}</strong>.`,
          reminder ? "This is a new link. Any earlier link for this document no longer works." : "This link is personal. Please do not forward it.",
          doc.expires_at ? `The link expires on ${esc(new Date(doc.expires_at).toUTCString())}.` : "",
        ].filter(Boolean),
        { label: "Review and sign", url: link },
      );
      break;
    }
    case "last_signer": {
      if (!signer || signer.status === "signed" || !["sent", "partially_signed"].includes(doc.status)) return;
      msg(signer.email, `Everyone else has signed "${doc.title}"`, [
        `Hi ${esc(signer.name)},`,
        `Everyone else has signed <strong>${title}</strong>. Only your signature is missing.`,
        "Please use the signing link from the earlier email. If you can't find it, reply to the sender and ask them to resend it.",
      ]);
      break;
    }
    case "revoked": {
      if (!signer) return;
      msg(signer.email, `"${doc.title}" was cancelled`, [
        `Hi ${esc(signer.name)},`,
        `${from} cancelled <strong>${title}</strong>. You don't need to do anything, and the signing link no longer works.`,
      ]);
      break;
    }
    case "declined": {
      const who = signer ? `${esc(signer.name)} (${esc(signer.email)})` : "A signer";
      for (const to of await adminEmails(ctx)) {
        msg(to, `"${doc.title}" was declined`, [
          `${who} declined <strong>${title}</strong>.`,
          signer?.decline_reason ? `Reason: “${esc(signer.decline_reason)}”` : "No reason was given.",
        ], { label: "Open document", url: `${ctx.config.publicUrl}/documents/${doc.id}` });
      }
      break;
    }
    case "expired": {
      for (const to of await adminEmails(ctx)) {
        msg(to, `"${doc.title}" expired`, [`<strong>${title}</strong> expired before everyone signed.`], {
          label: "Open document",
          url: `${ctx.config.publicUrl}/documents/${doc.id}`,
        });
      }
      break;
    }
    case "completed": {
      if (!signer) return;
      msg(
        signer.email,
        `Completed: "${doc.title}"`,
        [`Hi ${esc(signer.name)},`, `Everyone has signed <strong>${title}</strong>. A copy of the completed document is attached for your records.`],
        undefined,
        await attachments(account.config.attach_zip),
      );
      break;
    }
    case "completed_sender": {
      const atts = await attachments(account.config.attach_zip);
      for (const to of await adminEmails(ctx)) {
        msg(to, `Completed: "${doc.title}"`, [`Everyone has signed <strong>${title}</strong>. The signed PDF is attached. The full evidence package is available in Signed.md.`], {
          label: "Open document",
          url: `${ctx.config.publicUrl}/documents/${doc.id}`,
        }, atts);
      }
      break;
    }
  }

  for (const m of messages) await ctx.mailer.send(m, account.config.smtp);
}
