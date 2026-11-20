// Compile-time checks: the status columns in the database schema list exactly the states of the
// machines in @signed-md/core (packages/core/src/state.ts). Nothing here runs.
import type { DeliveryStatus, DocumentStatus, SignerStatus, TemplateVersionStatus, UserStatus } from "@signed-md/core";
import type { DocumentTable, SignerTable, TemplateVersionTable, UserTable, WebhookDeliveryTable } from "@signed-md/db";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const schemaMatchesMachines: [
  Same<DocumentTable["status"], DocumentStatus>,
  Same<SignerTable["status"], SignerStatus>,
  Same<TemplateVersionTable["approval_status"], TemplateVersionStatus>,
  Same<UserTable["status"], UserStatus>,
  Same<WebhookDeliveryTable["status"], DeliveryStatus>,
] = [true, true, true, true, true];
