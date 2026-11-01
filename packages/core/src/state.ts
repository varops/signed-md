import { SignedError } from "./errors.ts";

export const DocumentStatuses = [
  "draft",
  "sent",
  "partially_signed",
  "signed",
  "finalized",
  "declined",
  "expired",
  "revoked",
] as const;
export type DocumentStatus = (typeof DocumentStatuses)[number];

export type DocumentAction = "send" | "sign" | "complete" | "finalize" | "decline" | "expire" | "revoke";

/** Allowed transitions. See docs/spec.md §5. */
const TRANSITIONS: Record<DocumentAction, Partial<Record<DocumentStatus, DocumentStatus>>> = {
  send: { draft: "sent" },
  sign: { sent: "partially_signed", partially_signed: "partially_signed" },
  complete: { sent: "signed", partially_signed: "signed" },
  finalize: { signed: "finalized" },
  decline: { sent: "declined", partially_signed: "declined" },
  expire: { sent: "expired", partially_signed: "expired" },
  revoke: { sent: "revoked", partially_signed: "revoked" },
};

export const TERMINAL: ReadonlySet<DocumentStatus> = new Set(["finalized", "declined", "expired", "revoked"]);

export function canTransition(from: DocumentStatus, action: DocumentAction): boolean {
  return TRANSITIONS[action][from] !== undefined;
}

export function transition(from: DocumentStatus, action: DocumentAction): DocumentStatus {
  const to = TRANSITIONS[action][from];
  if (to === undefined) {
    if (action === "revoke") {
      throw new SignedError("DOCUMENT_NOT_REVOCABLE", `A ${from} document cannot be revoked`);
    }
    if (action === "send" && from !== "draft") {
      throw new SignedError("DOCUMENT_ALREADY_SENT", "This document has already been sent");
    }
    throw new SignedError("INVALID_TRANSITION", `Cannot ${action} a ${from} document`);
  }
  return to;
}
