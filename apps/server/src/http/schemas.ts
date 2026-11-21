import { z } from "@hono/zod-openapi";
import { DocumentStatuses, SignerStatuses, TemplateVersionStatuses } from "@signed-md/core";

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "FIELD_REQUIRED" }),
      message: z.string(),
      details: z.array(z.object({ code: z.string(), message: z.string(), field: z.string().optional() })),
    }),
  })
  .openapi("Error");

export const SignerInputSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(64).openapi({ example: "client", description: "Matches the signer key used in placeholders, e.g. {{client.signature:signature}}" }),
    name: z.string().trim().min(1).max(200).openapi({ example: "Jane Doe" }),
    email: z.email().max(320).openapi({ example: "jane@acme.example" }),
    order: z.number().int().min(0).max(1000).optional().openapi({ example: 1, description: "Signers with the same order sign in parallel. Lower orders sign first. Default 1. 0 means any order (everyone signs at once); use it for every signer or none." }),
  })
  .openapi("SignerInput");

const Metadata = z
  .record(z.string(), z.unknown())
  .refine((m) => JSON.stringify(m).length <= 8192, "metadata must be at most 8 KB")
  .openapi({ example: { customer_id: "acme" } });

export const CreateDocumentSchema = z
  .object({
    template_id: z.string().optional().openapi({ example: "tpl_123" }),
    template_version: z.number().int().min(1).optional().openapi({ description: "Defaults to the latest approved version." }),
    content: z.string().max(500_000).optional().openapi({ description: "Inline Markdown. Mutually exclusive with template_id." }),
    title: z.string().max(200).optional(),
    values: z.record(z.string(), z.unknown()).optional().openapi({ example: { client_name: "Acme Ltd", fee: "1000.00", notice_days: 30 }, description: "Template values, keyed without the $ prefix." }),
    signers: z.array(SignerInputSchema).max(50),
    expires_in_days: z.number().int().min(1).max(365).optional(),
    timezone: z.string().optional().openapi({ example: "Europe/London" }),
    locale: z.string().optional().openapi({ example: "en-US" }),
    webhook_url: z.string().url().nullable().optional(),
    metadata: Metadata.optional(),
    font: z.enum(["serif", "sans-serif"]).optional().openapi({ description: "Contract font family. Defaults to the account's setting (Settings → Branding)." }),
    reminders: z.boolean().optional().openapi({ description: "Email signers who haven't signed a reminder every 3 business days and 24 hours and 1 hour before the deadline, with the same link. Defaults to the account's setting." }),
    auto_send: z.boolean().optional().openapi({ description: "Send immediately if valid. Only for workflows where sending was already authorised." }),
    approved_by: z.string().max(500).optional().openapi({ description: "Recorded with auto_send." }),
    folder_id: z.string().nullable().optional().openapi({ description: "A document folder to file it in (GET /v1/folders?kind=document)." }),
  })
  .openapi("CreateDocument");

export const UpdateDocumentSchema = z
  .object({
    title: z.string().max(200).optional(),
    content: z.string().max(500_000).optional(),
    values: z.record(z.string(), z.unknown()).optional().openapi({ description: "Merged into existing values. Set a key to null to remove it." }),
    signers: z.array(SignerInputSchema).max(50).optional().openapi({ description: "Matched by key. Existing keys are replaced, new keys are added." }),
    remove_signers: z.array(z.string()).optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
    timezone: z.string().optional(),
    locale: z.string().optional(),
    webhook_url: z.string().url().nullable().optional(),
    metadata: Metadata.optional(),
    font: z.enum(["serif", "sans-serif"]).optional(),
    reminders: z.boolean().optional(),
  })
  .openapi("UpdateDocument");

export const SendSchema = z
  .object({
    approved_revision: z.string().openapi({ example: "rev_0f3a…", description: "The revision returned by preview that the human approved." }),
    approved_by: z.string().max(500).optional().openapi({ example: "Ran, via chat", description: "Who approved. Recorded as a statement, not a verified identity." }),
    message: z.string().max(2000).optional().openapi({ example: "Hi Jane, here's the agreement we discussed.", description: "Message to signers in the signing email. Defaults to the account's message from Settings → Branding. Placeholders, filled in per signer: {{recipient.name}}, {{recipient.first_name}}, {{recipient.email}}, {{document.title}}." }),
  })
  .openapi("SendDocument");

export const RevokeSchema = z.object({ reason: z.string().max(1000).optional() }).openapi("RevokeDocument");

const IssueSchema = z.object({ code: z.string(), message: z.string(), field: z.string().optional() }).openapi("Issue");

export const DocumentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(DocumentStatuses),
    owner: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable().openapi({ description: "The team member who owns and sent the document." }),
    revision: z.string(),
    source: z.enum(["template", "inline"]),
    template: z.object({ id: z.string(), version: z.number() }).nullable(),
    values: z.record(z.string(), z.unknown()),
    signers: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        email: z.string(),
        order: z.number(),
        status: z.enum(SignerStatuses),
        notified_at: z.string().nullable(),
        viewed_at: z.string().nullable(),
        signed_at: z.string().nullable(),
        declined_at: z.string().nullable(),
        decline_reason: z.string().nullable(),
        reminders_sent: z.number().openapi({ description: "Reminders sent so far, automatic and manual." }),
        last_reminded_at: z.string().nullable(),
      }),
    ),
    current_signing_group: z.number().nullable(),
    outstanding: z.array(z.object({ signer: z.string(), action: z.literal("sign") })),
    validation: z.object({ valid: z.boolean(), errors: z.array(IssueSchema) }).nullable(),
    approved_revision: z.string().nullable(),
    approved_by: z.string().nullable(),
    inline_approval: z.object({ required: z.boolean(), approved: z.boolean(), approved_at: z.string().nullable() }).nullable(),
    expires_in_days: z.number(),
    expires_at: z.string().nullable(),
    timezone: z.string(),
    locale: z.string(),
    webhook_url: z.string().nullable(),
    font: z.enum(["serif", "sans-serif"]),
    reminders: z.boolean().openapi({ description: "Signers who haven't signed get a reminder every 3 business days (Monday to Friday in the document's timezone), and 24 hours and 1 hour before the deadline." }),
    message: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    archived: z.boolean(),
    folder: z.object({ id: z.string(), name: z.string() }).nullable().openapi({ description: "The folder it is filed in. Folders only organise; they don't affect permissions or the revision." }),
    created_at: z.string(),
    updated_at: z.string(),
    sent_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    finalized_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    revoke_reason: z.string().nullable(),
    links: z.object({ self: z.string(), preview: z.string(), artifacts: z.string(), ui: z.string() }),
  })
  .openapi("Document");

export const ValidationSchema = z
  .object({ valid: z.boolean(), revision: z.string(), errors: z.array(IssueSchema), warnings: z.array(IssueSchema) })
  .openapi("Validation");

export const PreviewSchema = ValidationSchema.extend({
  document_id: z.string(),
  title: z.string(),
  status: z.string(),
  markdown: z.string().openapi({ description: "Agreement with template values filled in. Signer fields remain as placeholders." }),
  html: z.string(),
  values: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), value: z.unknown(), display: z.string().nullable() })),
  signer_fields: z.array(z.object({ signer: z.string(), fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean() })) })),
  signing_order: z.array(z.object({ order: z.number(), signers: z.array(z.object({ key: z.string(), name: z.string(), email: z.string() })) })),
  template: z.object({ id: z.string(), version: z.number() }).nullable(),
  source: z.enum(["template", "inline"]),
  font: z.enum(["serif", "sans-serif"]),
}).openapi("Preview");

export const TemplateCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    source: z.string().min(1).max(500_000).openapi({ description: "Markdown with placeholders and optional front matter." }),
    folder_id: z.string().nullable().optional().openapi({ description: "A template folder to file it in (GET /v1/folders?kind=template)." }),
  })
  .openapi("CreateTemplate");

export const TemplateVersionCreateSchema = z
  .object({ source: z.string().min(1).max(500_000), name: z.string().max(200).optional(), description: z.string().max(2000).optional() })
  .openapi("CreateTemplateVersion");

const FieldDefSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["value", "signer"]),
    name: z.string().optional(),
    signer: z.string().optional(),
    type: z.string(),
    param: z.string().optional(),
    rules: z.record(z.string(), z.unknown()),
  })
  .openapi("FieldDef");

const TemplateVersionSchema = z.object({
  version: z.number(),
  approval_status: z.enum(TemplateVersionStatuses),
  created_by: z.string(),
  created_at: z.string(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  content_hash: z.string(),
});

export const TemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    created_via: z.string(),
    current_version: z.number(),
    approved_version: z.number().nullable().openapi({ description: "Used by default for new documents. Null until a person approves a version in the web UI." }),
    archived: z.boolean(),
    folder: z.object({ id: z.string(), name: z.string() }).nullable().openapi({ description: "The folder it is filed in. Folders only organise; they don't affect permissions or the revision." }),
    created_at: z.string(),
    versions: z.array(TemplateVersionSchema),
  })
  .openapi("Template");

export const TemplateDetailSchema = TemplateSchema.extend({
  source: z.string(),
  fields: z.array(FieldDefSchema),
  version_shown: z.number(),
}).openapi("TemplateDetail");

export const TemplateVersionDetailSchema = TemplateVersionSchema.extend({
  template_id: z.string(),
  source: z.string(),
  fields: z.array(FieldDefSchema),
}).openapi("TemplateVersionDetail");

export const FolderSchema = z
  .object({ id: z.string(), kind: z.enum(["template", "document"]), name: z.string(), created_at: z.string() })
  .openapi("Folder");
export const FolderCreateSchema = z
  .object({ kind: z.enum(["template", "document"]), name: z.string().trim().min(1).max(80) })
  .openapi("CreateFolder");
export const FolderUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .openapi("UpdateFolder");
export const MoveSchema = z
  .object({ folder_id: z.string().nullable().openapi({ description: "The folder to file it in, or null for no folder." }) })
  .openapi("Move");

export const ArtifactSchema = z
  .object({
    id: z.string(),
    type: z.enum(["pdf", "zip"]),
    filename: z.string(),
    sha256: z.string(),
    size: z.number(),
    created_at: z.string(),
    download: z.object({ url: z.string(), expires_at: z.string() }),
  })
  .openapi("Artifact");

export const AccountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    settings: z.object({
      webhook_url: z.string().nullable(),
      inline_documents: z.enum(["allowed", "needs_approval", "disabled"]),
      default_expiry_days: z.number(),
      reminders: z.boolean().openapi({ description: "Default for new documents." }),
      timezone: z.string(),
      locale: z.string(),
    }),
    created_at: z.string(),
  })
  .openapi("Account");

export const WebhookConfigSchema = z
  .object({
    url: z.string().nullable(),
    secret: z.string().openapi({ description: "HMAC-SHA256 secret. Verify Signed-Md-Signature: t=<ts>,v1=hex(hmac(secret, `${t}.${body}`))." }),
    events: z.array(z.string()),
  })
  .openapi("WebhookConfig");

export const WebhookUpdateSchema = z
  .object({ url: z.string().url().nullable(), rotate_secret: z.boolean().optional() })
  .openapi("UpdateWebhook");
