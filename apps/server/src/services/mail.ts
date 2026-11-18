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
  /** Content-ID for inline images referenced as cid:<id> in the HTML. */
  cid?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
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
  /** SMTP from the SMTP_* environment variables. Null writes emails to the outbox. */
  readonly smtp: SmtpConfig | null;
  private transportKey = "";
  private transport: Transporter | null = null;

  constructor(dataDir: string, smtp: SmtpConfig | null) {
    this.outboxDir = join(dataDir, "outbox");
    mkdirSync(this.outboxDir, { recursive: true });
    this.smtp = smtp;
  }

  async send(msg: MailMessage): Promise<"smtp" | "outbox"> {
    const smtp = this.smtp;
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
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })) ?? [],
    });
    return "smtp";
  }

  private async toOutbox(msg: MailMessage): Promise<void> {
    const created_at = new Date().toISOString();
    const id = `${created_at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    // Inline images become data URLs so the outbox can show the email as it would look.
    let html = msg.html;
    for (const a of msg.attachments ?? []) {
      if (a.cid) html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString("base64")}`);
    }
    const entry: OutboxEntry = {
      id,
      created_at,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html,
      attachments: (msg.attachments ?? []).filter((a) => !a.cid).map((a) => ({ filename: a.filename, size: a.content.length })),
    };
    await writeFile(join(this.outboxDir, `${id}.json`), JSON.stringify(entry, null, 2));
    log.info("email written to outbox (no SMTP configured)", { to: msg.to, subject: msg.subject });
  }

  async outbox(limit = 100): Promise<OutboxEntry[]> {
    const files = (await readdir(this.outboxDir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.outboxDir, f), "utf8")) as OutboxEntry));
  }

  async outboxEntry(id: string): Promise<OutboxEntry | null> {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.outboxDir, `${id}.json`), "utf8")) as OutboxEntry;
    } catch {
      return null;
    }
  }

  async verify(): Promise<void> {
    const smtp = this.smtp;
    if (!smtp) throw new Error("No SMTP server configured");
    await nodemailer
      .createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}) })
      .verify();
  }
}
