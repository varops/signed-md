import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import type { SmtpConfig } from "../config.ts";
import { log } from "../log.ts";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

export interface OutboxEntry {
  id: string;
  created_at: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; size: number }[];
}

/**
 * Sends email over SMTP. When no SMTP is configured, messages go to a local outbox
 * (DATA_DIR/outbox) that the web UI shows, so a fresh install can be tried end to end.
 */
export class Mailer {
  private readonly outboxDir: string;
  private readonly envSmtp: SmtpConfig | null;
  private transportKey = "";
  private transport: Transporter | null = null;

  constructor(dataDir: string, envSmtp: SmtpConfig | null) {
    this.outboxDir = join(dataDir, "outbox");
    mkdirSync(this.outboxDir, { recursive: true });
    this.envSmtp = envSmtp;
  }

  /** Account SMTP (saved in the UI) wins over environment SMTP. */
  effectiveSmtp(accountSmtp: SmtpConfig | null): SmtpConfig | null {
    return accountSmtp?.host ? accountSmtp : this.envSmtp;
  }

  async send(msg: MailMessage, accountSmtp: SmtpConfig | null): Promise<"smtp" | "outbox"> {
    const smtp = this.effectiveSmtp(accountSmtp);
    if (!smtp) {
      await this.toOutbox(msg);
      return "outbox";
    }
    const key = JSON.stringify(smtp);
    if (!this.transport || key !== this.transportKey) {
      this.transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
      });
      this.transportKey = key;
    }
    await this.transport.sendMail({
      from: smtp.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) ?? [],
    });
    return "smtp";
  }

  private async toOutbox(msg: MailMessage): Promise<void> {
    const created_at = new Date().toISOString();
    const id = `${created_at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: OutboxEntry = {
      id,
      created_at,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, size: a.content.length })),
    };
    await writeFile(join(this.outboxDir, `${id}.json`), JSON.stringify(entry, null, 2));
    log.info("email written to outbox (no SMTP configured)", { to: msg.to, subject: msg.subject });
  }

  async outbox(limit = 100): Promise<OutboxEntry[]> {
    const files = (await readdir(this.outboxDir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.outboxDir, f), "utf8")) as OutboxEntry));
  }

  async verify(accountSmtp: SmtpConfig | null): Promise<void> {
    const smtp = this.effectiveSmtp(accountSmtp);
    if (!smtp) throw new Error("No SMTP server configured");
    await nodemailer
      .createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}) })
      .verify();
  }
}
