import { type ErrorCode, SignedError } from "@signed-md/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "../log.ts";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  TEMPLATE_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  TEMPLATE_NOT_APPROVED: 409,
  TEMPLATE_INVALID: 422,
  INLINE_DISABLED: 403,
  FIELD_REQUIRED: 422,
  FIELD_INVALID: 422,
  FIELD_UNKNOWN: 422,
  SIGNER_MISSING: 422,
  SIGNER_INVALID: 422,
  REVISION_MISMATCH: 409,
  DOCUMENT_NOT_DRAFT: 409,
  DOCUMENT_NOT_APPROVED: 409,
  DOCUMENT_ALREADY_SENT: 409,
  DOCUMENT_NOT_REVOCABLE: 409,
  DOCUMENT_NOT_FINALIZED: 409,
  INVALID_TRANSITION: 409,
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
};

export function errorBody(err: SignedError) {
  return { error: { code: err.code, message: err.message, details: err.issues } };
}

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof SignedError) return c.json(errorBody(err), STATUS[err.code] ?? 400);
  log.error("unhandled error", { error: (err as Error).message, stack: (err as Error).stack });
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong. Check the server logs.", details: [] } }, 500);
}

export function statusFor(code: ErrorCode): ContentfulStatusCode {
  return STATUS[code] ?? 400;
}
