/** Stable error codes shared by REST, MCP, and the UI. See docs/integrations.md §17. */
export const ErrorCodes = [
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_NOT_APPROVED",
  "TEMPLATE_INVALID",
  "INLINE_DISABLED",
  "FIELD_REQUIRED",
  "FIELD_INVALID",
  "FIELD_UNKNOWN",
  "SIGNER_MISSING",
  "SIGNER_INVALID",
  "REVISION_MISMATCH",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_NOT_DRAFT",
  "DOCUMENT_NOT_APPROVED",
  "DOCUMENT_ALREADY_SENT",
  "DOCUMENT_NOT_REVOCABLE",
  "DOCUMENT_NOT_FINALIZED",
  "INVALID_TRANSITION",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export interface Issue {
  code: ErrorCode;
  message: string;
  /** Field key (e.g. "$fee" or "client.signature") or request path the issue refers to. */
  field?: string;
}

export class SignedError extends Error {
  readonly code: ErrorCode;
  readonly issues: Issue[];

  constructor(code: ErrorCode, message: string, issues: Issue[] = []) {
    super(message);
    this.name = "SignedError";
    this.code = code;
    this.issues = issues;
  }
}
