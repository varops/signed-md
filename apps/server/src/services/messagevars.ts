import { SignedError } from "@signed-md/core";

/** Placeholders allowed in the message to signers. */
export const MESSAGE_VARIABLES = ["recipient.name", "recipient.first_name", "recipient.email", "document.title"] as const;

const VAR = /\{\{\s*([a-z_.]+)\s*\}\}/gi;

/** Reject unknown placeholders, so a typo never reaches a signer as raw braces. */
export function checkMessageVariables(message: string, field = "message"): void {
  const unknown = [...message.matchAll(VAR)].map((m) => m[1]!).filter((v) => !(MESSAGE_VARIABLES as readonly string[]).includes(v));
  if (unknown.length) {
    throw new SignedError(
      "INVALID_REQUEST",
      `Unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use ${MESSAGE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`,
      [{ code: "INVALID_REQUEST", field, message: "Unknown placeholder" }],
    );
  }
}

/** Fill in the placeholders for one signer. The result is plain text; the email template escapes it. */
export function personalizeMessage(message: string, vars: { name: string; email: string; title: string }): string {
  const values: Record<string, string> = {
    "recipient.name": vars.name,
    "recipient.first_name": vars.name.trim().split(/\s+/)[0] ?? vars.name,
    "recipient.email": vars.email,
    "document.title": vars.title,
  };
  return message.replace(VAR, (whole, key: string) => values[key] ?? whole);
}
