import { SignedError } from "./errors.ts";

/**
 * Every lifecycle in Signed.md, as explicit transition tables. Code never writes a status
 * literal directly: it asks the machine for the next state, and the database update checks
 * the state it started from (compare-and-set), so two racing requests can't both win.
 * See docs/spec.md §5.
 */
export interface Machine<S extends string, A extends string> {
  readonly name: string;
  readonly states: readonly S[];
  /** True when `action` is allowed in state `from`. */
  can(from: S, action: A): boolean;
  /** The state after `action`, or an INVALID_TRANSITION error. */
  next(from: S, action: A): S;
  /** The states `action` is allowed from, for `where status in (...)` guards. */
  sources(action: A): S[];
}

export function machine<S extends string, A extends string>(
  name: string,
  states: readonly S[],
  table: Record<A, Partial<Record<S, S>>>,
): Machine<S, A> {
  return {
    name,
    states,
    can: (from, action) => table[action][from] !== undefined,
    next(from, action) {
      const to = table[action][from];
      if (to === undefined) throw new SignedError("INVALID_TRANSITION", `Cannot ${action} a ${from} ${name}`);
      return to;
    },
    sources: (action) => Object.keys(table[action]) as S[],
  };
}

// ---------------------------------------------------------------------------
// Documents

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

export const documentMachine = machine<DocumentStatus, DocumentAction>("document", DocumentStatuses, {
  send: { draft: "sent" },
  sign: { sent: "partially_signed", partially_signed: "partially_signed" },
  complete: { sent: "signed", partially_signed: "signed" },
  finalize: { signed: "finalized" },
  decline: { sent: "declined", partially_signed: "declined" },
  expire: { sent: "expired", partially_signed: "expired" },
  revoke: { sent: "revoked", partially_signed: "revoked" },
});

export const TERMINAL: ReadonlySet<DocumentStatus> = new Set(["finalized", "declined", "expired", "revoked"]);

/** Out for signature: signers can sign, decline, get reminders; owners can revoke. */
export const OPEN_STATUSES = documentMachine.sources("sign");

export function isOpenStatus(status: DocumentStatus): boolean {
  return documentMachine.can(status, "sign");
}

export function isDocumentStatus(s: string): s is DocumentStatus {
  return (DocumentStatuses as readonly string[]).includes(s);
}

export function canTransition(from: DocumentStatus, action: DocumentAction): boolean {
  return documentMachine.can(from, action);
}

export function transition(from: DocumentStatus, action: DocumentAction): DocumentStatus {
  if (!documentMachine.can(from, action)) {
    if (action === "revoke") throw new SignedError("DOCUMENT_NOT_REVOCABLE", `A ${from} document cannot be revoked`);
    if (action === "send") throw new SignedError("DOCUMENT_ALREADY_SENT", "This document has already been sent");
  }
  return documentMachine.next(from, action);
}

// ---------------------------------------------------------------------------
// Signers

export const SignerStatuses = ["pending", "notified", "viewed", "signed", "declined"] as const;
export type SignerStatus = (typeof SignerStatuses)[number];
export type SignerAction = "notify" | "view" | "sign" | "decline";

/** A signer waits for their group (pending), gets a link (notified), opens it (viewed), then signs or declines. */
export const signerMachine = machine<SignerStatus, SignerAction>("signer", SignerStatuses, {
  // A fresh link (a resend or reminder) keeps the signer where they are.
  notify: { pending: "notified", notified: "notified", viewed: "viewed" },
  view: { notified: "viewed" },
  sign: { notified: "signed", viewed: "signed" },
  decline: { notified: "declined", viewed: "declined" },
});

/** Has a link and still has to act. */
export function isAwaitingSigner(status: SignerStatus): boolean {
  return signerMachine.can(status, "sign");
}

// ---------------------------------------------------------------------------
// Template versions

export const TemplateVersionStatuses = ["pending_approval", "approved"] as const;
export type TemplateVersionStatus = (typeof TemplateVersionStatuses)[number];

export const templateVersionMachine = machine<TemplateVersionStatus, "approve">("template version", TemplateVersionStatuses, {
  approve: { pending_approval: "approved" },
});

// ---------------------------------------------------------------------------
// People

export const UserStatuses = ["active", "disabled"] as const;
export type UserStatus = (typeof UserStatuses)[number];

export const userMachine = machine<UserStatus, "deactivate" | "reactivate">("user", UserStatuses, {
  deactivate: { active: "disabled" },
  reactivate: { disabled: "active" },
});

// ---------------------------------------------------------------------------
// Invitations. The state is derived from timestamps, so it is computed here, once.

export const InvitationStatuses = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof InvitationStatuses)[number];

export const invitationMachine = machine<InvitationStatus, "accept" | "revoke">("invitation", InvitationStatuses, {
  accept: { pending: "accepted" },
  revoke: { pending: "revoked" },
});

export function invitationStatus(
  inv: { accepted_at: string | null; revoked_at: string | null; expires_at: string },
  at: string = new Date().toISOString(),
): InvitationStatus {
  if (inv.accepted_at) return "accepted";
  if (inv.revoked_at) return "revoked";
  if (inv.expires_at <= at) return "expired";
  return "pending";
}

// ---------------------------------------------------------------------------
// Webhook deliveries

export const DeliveryStatuses = ["pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DeliveryStatuses)[number];

export const deliveryMachine = machine<DeliveryStatus, "deliver" | "retry" | "give_up">("webhook delivery", DeliveryStatuses, {
  deliver: { pending: "delivered" },
  retry: { pending: "pending" },
  give_up: { pending: "failed" },
});
