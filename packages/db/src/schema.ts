/**
 * Database schema. Portable across SQLite and PostgreSQL:
 * text IDs, ISO 8601 UTC timestamps as text, JSON as text, integers for counters.
 * Nothing is ever deleted; hidden records carry `archived_at`.
 */
export interface Database {
  accounts: AccountTable;
  users: UserTable;
  sessions: SessionTable;
  api_keys: ApiKeyTable;
  templates: TemplateTable;
  template_versions: TemplateVersionTable;
  documents: DocumentTable;
  signers: SignerTable;
  fields: FieldTable;
  events: EventTable;
  artifacts: ArtifactTable;
  jobs: JobTable;
  idempotency_keys: IdempotencyTable;
  webhook_deliveries: WebhookDeliveryTable;
}

export interface AccountTable {
  id: string;
  name: string;
  /** JSON: AccountConfig */
  config: string;
  created_at: string;
}

export interface UserTable {
  id: string;
  account_id: string;
  email: string;
  password_hash: string | null;
  status: "active" | "disabled";
  created_at: string;
}

export interface SessionTable {
  /** SHA-256 of the session token. */
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface ApiKeyTable {
  id: string;
  account_id: string;
  user_id: string | null;
  key_hash: string;
  /** First characters of the key, shown in the UI to identify it. */
  prefix: string;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface TemplateTable {
  id: string;
  account_id: string;
  name: string;
  description: string;
  current_version: number;
  created_via: "ui" | "api" | "mcp";
  created_at: string;
  archived_at: string | null;
}

export interface TemplateVersionTable {
  id: string;
  template_id: string;
  version: number;
  source: string;
  /** JSON: FieldDef[] */
  field_schema: string;
  content_hash: string;
  created_by: string;
  approval_status: "pending_approval" | "approved";
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface DocumentTable {
  id: string;
  account_id: string;
  template_version_id: string | null;
  source_kind: "template" | "inline";
  /** Markdown source as created (template source or inline content). */
  source: string;
  /** JSON: normalised template values. */
  values_json: string;
  /** Markdown with template values resolved. */
  content: string;
  revision: string;
  status: string;
  title: string;
  timezone: string;
  locale: string;
  expires_in_days: number;
  /** JSON object. */
  metadata: string;
  webhook_url: string | null;
  created_by: string;
  approved_revision: string | null;
  approved_by: string | null;
  inline_approved_by: string | null;
  inline_approved_at: string | null;
  inline_approved_revision: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  finalized_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  archived_at: string | null;
}

export interface SignerTable {
  id: string;
  document_id: string;
  key: string;
  name: string;
  email: string;
  signing_order: number;
  token_hash: string | null;
  status: "pending" | "notified" | "viewed" | "signed" | "declined";
  decline_reason: string | null;
  notified_at: string | null;
  viewed_at: string | null;
  consented_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
}

export interface FieldTable {
  id: string;
  document_id: string;
  key: string;
  kind: "value" | "signer";
  type: string;
  signer_key: string | null;
  /** Order of first appearance in the document. */
  position: number;
  /** JSON: FieldDef */
  definition: string;
  /** JSON-encoded value, null until completed. */
  value: string | null;
  completed_at: string | null;
}

export interface EventTable {
  id: string;
  document_id: string;
  seq: number;
  type: string;
  actor: string;
  created_at: string;
  /** JSON evidence metadata (IP, user agent, details). */
  data: string;
  prev_hash: string | null;
  hash: string;
}

export interface ArtifactTable {
  id: string;
  document_id: string;
  type: string;
  storage_path: string;
  sha256: string;
  size: number;
  created_at: string;
}

export interface JobTable {
  id: string;
  type: string;
  /** JSON payload. */
  payload: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_until: string | null;
  last_error: string | null;
  /** Optional unique key that prevents enqueuing the same job twice. */
  dedupe_key: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface IdempotencyTable {
  key: string;
  /** Who used the key and for which operation, e.g. "apikey:key_x:POST /v1/documents". */
  scope: string;
  request_hash: string;
  /** JSON: { status, body } */
  response: string;
  created_at: string;
}

export interface WebhookDeliveryTable {
  id: string;
  event_id: string;
  event_type: string;
  document_id: string | null;
  url: string;
  /** JSON body exactly as sent. */
  body: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}
