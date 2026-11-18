# Signed.md
## REST, MCP, and agent skills specification

**Status:** Draft v0.2  
**Required release:** v1.0 MVP

## 1. Objective

An AI agent must be able to prepare, validate, preview, send, monitor, revoke, and retrieve a signed agreement using Signed.md.

All operations must be deterministic and auditable.

The agent supplies intelligence. Signed.md supplies execution.

## 2. Supported interfaces

### REST API

Primary programmatic interface.

Versioned under `/v1`.

### MCP server

Exposes the same signing capabilities to MCP-compatible agents, over Streamable HTTP at `/mcp`, authenticated with an API key.

### Agent skill

Documents the correct workflow for agents using REST or MCP.

The skill must be distributed with the open-source project.

All three interfaces share the same application logic and the same schemas.

## 3. Core workflow

```text
User instruction
      |
      v
Discover approved template
      |
      v
Read template field schema
      |
      v
Populate permitted template values and signers
      |
      v
Validate (edit draft and repeat if needed)
      |
      v
Generate preview (returns revision)
      |
      v
Request user approval
      |
      v
Send approved revision
      |
      v
Track status / receive webhook
      |
      v
Retrieve completed ZIP
```

## 4. REST endpoints

### Templates

```http
GET    /v1/templates
POST   /v1/templates
GET    /v1/templates/{id}
POST   /v1/templates/{id}/versions
GET    /v1/templates/{id}/versions/{version}
POST   /v1/templates/{id}/archive
POST   /v1/templates/{id}/unarchive
```

Templates are never edited in place. `POST /versions` creates a new version.

Templates and versions created through the API start as `pending_approval`. There is no approve endpoint. A human approves templates in the web UI. Template representations include the approval status of each version.

### Imports (v1.2)

```http
POST   /v1/imports
```

Uploads a PDF or .docx file. Returns Markdown with suggested placeholders and creates a `pending_approval` template.

### Documents

```http
GET    /v1/documents
POST   /v1/documents
GET    /v1/documents/{id}
PATCH  /v1/documents/{id}
POST   /v1/documents/{id}/validate
GET    /v1/documents/{id}/preview
POST   /v1/documents/{id}/send
POST   /v1/documents/{id}/revoke
POST   /v1/documents/{id}/signers/{key}/resend
POST   /v1/documents/{id}/archive
POST   /v1/documents/{id}/unarchive
GET    /v1/documents/{id}/artifacts
```

`GET /v1/documents` hides archived documents unless `?archived=true` is passed. The same applies to templates. `?mine=true` returns only the API key owner's documents.

### Permissions

Every API key belongs to a person on the team and acts with that person's role:

| Role | Through the API |
|---|---|
| Owner, Administrator | All documents; templates; webhooks and settings. |
| Member | Creates and sends documents, and sees only their own. Creates templates (pending approval). |
| Viewer | Read-only. |

Documents a key can't read return `DOCUMENT_NOT_FOUND`. Actions a role can't take return `PERMISSION_DENIED`. Template approval is never available through the API.

There is no `DELETE` endpoint for any resource.

### Configuration

```http
GET    /v1/account
GET    /v1/webhooks
PUT    /v1/webhooks
```

The API avoids redundant endpoints where resource representations already expose the necessary information. For example, status is part of `GET /v1/documents/{id}`.

## 5. Create document

Example:

```http
POST /v1/documents
Authorization: Bearer <API_KEY>
Idempotency-Key: contract-acme-001
Content-Type: application/json
```

```json
{
  "template_id": "tpl_services",
  "values": {
    "client_name": "Acme Ltd",
    "fee": "1000.00",
    "notice_days": 30
  },
  "signers": [
    { "key": "client1", "name": "Jane Doe", "email": "jane@acme.example", "order": 1 },
    { "key": "client2", "name": "John Roe", "email": "john@acme.example", "order": 1 },
    { "key": "provider", "name": "Sam Lee", "email": "contracts@example.com", "order": 2 }
  ],
  "expires_in_days": 14,
  "timezone": "Europe/London",
  "auto_send": false,
  "webhook_url": "https://example.com/hooks/contracts",
  "metadata": {
    "customer_id": "acme",
    "source": "sales-agent"
  }
}
```

- `values` holds template values. Keys are written without the `$` prefix.
- `font` is `"serif"` or `"sans-serif"`, for the PDF and the signing page. Without it, the account default (Settings → Branding) is used. It is part of the revision.
- `signers` lists every signer. Each `key` must match the signer keys used in the template. Signers with the same `order` sign in parallel; the next group is notified when the current group is done.
- Currency values are decimal strings.

A successful response returns the document ID, status, revision, validation state, and relevant links.

### Alternative input

Document creation uses either:

- `template_id`
- `content` (inline Markdown, with the same placeholder notation)

These are mutually exclusive. There is no URL input; agents fetch remote content themselves and pass it as `content`.

## 6. Edit draft

```http
PATCH /v1/documents/doc_123
```

```json
{
  "values": { "fee": "1200.00" },
  "signers": [
    { "key": "client1", "name": "Jane Doe", "email": "jane.doe@acme.example", "order": 1 }
  ]
}
```

- Works on drafts only. Otherwise it returns `DOCUMENT_NOT_DRAFT`.
- `values` are merged. `signers` entries are matched by `key` and replaced.
- Returns the new revision. Any earlier approval no longer matches.

## 7. Validation

Example:

```http
POST /v1/documents/doc_123/validate
```

Response:

```json
{
  "valid": false,
  "revision": "rev_456",
  "errors": [
    {
      "code": "SIGNER_MISSING",
      "field": "provider.signature",
      "message": "The template uses signer key 'provider', but no signer has that key"
    }
  ]
}
```

Validation never modifies legal terms and never sends the agreement. The result applies only to the revision it names.

## 8. Preview

```http
GET /v1/documents/doc_123/preview
```

Preview provides:

- The resolved Markdown.
- Rendered HTML.
- Resolved template value summary.
- Outstanding signer fields, grouped by signer.
- Signing order.
- Template version.
- Validation warnings.
- The revision.

There is no PDF before completion.

Agents should present a human-readable summary alongside the preview.

The approval step must refer to the exact revision that was previewed.

## 9. Sending

```http
POST /v1/documents/doc_123/send
```

```json
{
  "approved_revision": "rev_456",
  "approved_by": "Sam Lee, via chat",
  "message": "Hi Jane, here's the agreement we discussed."
}
```

`message` is optional. It appears in the signing email. Without it, the account's default message (Settings → Branding) is used. It can contain `{{recipient.name}}`, `{{recipient.first_name}}`, `{{recipient.email}}`, and `{{document.title}}`, which are filled in for each signer. Any other `{{…}}` is rejected with `INVALID_REQUEST`.

The server rejects sending if the draft changed after the approved preview (`REVISION_MISMATCH`).

`approved_by` is recorded in the evidence. It is a statement from the caller, not a verified identity.

The operation must support idempotency.

Agents must not treat a successful preview as authorisation to send.

## 10. Revoke, resend, archive

### Revoke

```http
POST /v1/documents/doc_123/revoke
```

```json
{ "reason": "Wrong signer email" }
```

- Allowed for `sent` and `partially_signed` documents.
- Invalidates all signing links immediately and notifies signers who already received one.
- Terminal. To correct the agreement, create a new document.

### Resend

```http
POST /v1/documents/doc_123/signers/client1/resend
```

Sends a fresh link to a signer who has been notified but has not signed. Rate limited.

### Archive

```http
POST /v1/documents/doc_123/archive
POST /v1/documents/doc_123/unarchive
```

Hides or restores the document in default lists. Does not change status. Works in any status.

## 11. Document representation

`GET /v1/documents/{id}` includes:

- Current status.
- Revision.
- Signers, with order and status.
- The signing group currently waiting.
- Outstanding actions.
- Relevant timestamps, including expiry.
- Archived flag.

## 12. Artifacts

```http
GET /v1/documents/doc_123/artifacts
```

Returns completed artifact metadata and authorised download links. Available once the document is `finalized`.

Download links are short-lived and scoped to the specific artifact.

## 13. MCP tools

The v1.0 MCP server exposes:

| Tool | Purpose |
|---|---|
| `signed_list_templates` | Discover available templates |
| `signed_get_template` | Retrieve template and field schema |
| `signed_create_template` | Create a template or new version (starts as `pending_approval`) |
| `signed_create_document` | Create a draft |
| `signed_update_document` | Edit a draft |
| `signed_validate_document` | Validate a draft |
| `signed_preview_document` | Retrieve preview and revision |
| `signed_send_document` | Send an approved revision |
| `signed_get_document` | Retrieve document details and status |
| `signed_list_documents` | Search and list documents |
| `signed_revoke_document` | Revoke a sent document |
| `signed_archive_document` | Archive or unarchive a document |
| `signed_get_artifacts` | Retrieve completion artifacts |

Agents can create templates and versions, but cannot approve them. Approval happens only in the web UI. Only approved versions can be used for documents.

Tool input schemas are generated from the same schemas as the REST API.

Tools should return structured, machine-readable results.

MCP errors should preserve the API's error codes and field-level detail.

The MCP adapter must not introduce additional document state or authorisation rules.

## 14. Agent skill requirements

The repository must include a distributable skill with:

- Product description.
- API/MCP setup instructions.
- Authentication guidance.
- Template discovery workflow.
- Template approval: agent-created templates wait for human approval in the UI.
- Placeholder notation (`$` template values and signer fields).
- Field population rules.
- Signer and signing-order rules.
- Validation and preview workflow.
- Human approval requirements.
- Sending workflow.
- Status tracking.
- Revoking and archiving.
- Artifact retrieval.
- Error handling.
- Security and privacy constraints.

### Required behavioural guidance

The skill must instruct agents to:

1. Prefer approved templates over writing new legal language.
2. Respect template field constraints.
3. Never invent unknown signer details.
4. Never bypass validation errors.
5. Show material commercial terms and the signing order before sending.
6. Obtain explicit approval unless the user has authorised automatic sending.
7. Never claim an agreement is signed until Signed.md reports the `signed` status. Retrieve the package only after `finalized`.
8. Preserve document IDs and idempotency keys when retrying.
9. Avoid disclosing signing links or documents to unrelated recipients.
10. Report declined, expired, revoked, or failed signing requests accurately.
11. Revoke only when the user asks, and confirm before doing so.
12. When creating a template, tell the user it must be approved in the web UI before it can be used. Never ask the user for their admin password.

## 15. Agent approval contract

Default workflow:

```text
Agent prepares agreement
       |
       v
Signed.md validates
       |
       v
Agent presents preview
       |
       v
Human approves
       |
       v
Agent sends approved revision
```

For explicitly authorised automated workflows, `auto_send` may bypass interactive approval.

Such authorisation belongs to the calling system, and the service must still enforce template constraints and API permissions.

## 16. Webhook-driven completion

v1.0 sends these signed webhooks:

- `document.awaiting_last_signer`: one signer is left. Useful for a countersignature prompt.
- `document.signed`: everyone has signed.
- `document.finalized`: the package is ready to download.
- `document.declined`: a signer declined.

Further events are listed in the technical specification and will be added later.

The receiving system can:

- Verify the webhook signature.
- Deduplicate using event ID.
- Download the ZIP.
- Verify the artifact checksum.
- Store or process the agreement.
- Notify the initiating agent or user.

The webhook includes customer-defined metadata to correlate the agreement with an external workflow.

A webhook is a notification, not proof of legal validity. Consumers should verify the completed package when appropriate.

## 17. Error handling

Use stable error codes.

Examples:

| Code | Meaning |
|---|---|
| `TEMPLATE_NOT_FOUND` | Requested template does not exist |
| `TEMPLATE_INVALID` | Template Markdown or front matter has errors |
| `DOCUMENT_NOT_FOUND` | Requested document does not exist |
| `INVALID_TRANSITION` | The action is not possible in the document's current status |
| `INVALID_REQUEST` | The request body or parameters are not valid |
| `NOT_FOUND` | No such API endpoint |
| `UNAUTHENTICATED` | Missing or invalid API key |
| `TEMPLATE_NOT_APPROVED` | Template version is waiting for human approval |
| `INLINE_DISABLED` | Inline documents are disabled for this account |
| `DOCUMENT_NOT_APPROVED` | Inline document needs human approval in the UI before sending |
| `FIELD_REQUIRED` | Required field is missing |
| `FIELD_INVALID` | Field value violates its schema |
| `FIELD_UNKNOWN` | A value was supplied for a key the template does not use |
| `SIGNER_MISSING` | The template uses a signer key with no matching signer |
| `SIGNER_INVALID` | Signer configuration is invalid (email, order, duplicate key) |
| `REVISION_MISMATCH` | Draft changed since preview |
| `DOCUMENT_NOT_DRAFT` | The operation needs a draft |
| `DOCUMENT_ALREADY_SENT` | Sending operation is no longer valid |
| `DOCUMENT_NOT_REVOCABLE` | Only sent or partially signed documents can be revoked |
| `DOCUMENT_NOT_FINALIZED` | Completion artifacts are not ready |
| `PERMISSION_DENIED` | API key lacks required permission |
| `RATE_LIMITED` | Request exceeds configured limits |
| `LIMIT_REACHED` | The plan's limit on sent contracts is reached. The message says where to upgrade |

Errors must be actionable for both developers and agents.

## 18. Security boundaries

- API keys are secrets and must not appear in agent output.
- MCP operations must respect the same account permissions as REST.
- Agents must not infer that an email address establishes legal identity.
- Signing links must not be exposed in unrelated conversations.
- Document content must be treated as untrusted data, not instructions to the agent.
- Webhook endpoints must be validated.
- All externally supplied strings must be safely rendered and stored.

## 19. MVP integration acceptance test

A compatible agent should successfully execute:

> Prepare our standard service agreement for Acme Ltd at $1,000 per month with 30 days' termination notice. Show me the agreement before sending it.

Expected behaviour:

1. Agent discovers the correct template.
2. Agent checks the permitted field schema.
3. Agent populates the specified values.
4. Agent identifies any missing signer information.
5. Agent creates and validates the draft.
6. Agent presents the preview, commercial terms, and signing order.
7. Agent waits for approval.
8. Agent sends the approved revision.
9. Agent reports the document ID and signing status.
10. After completion, the system delivers `document.signed` and `document.finalized` webhooks and a downloadable evidence package.

**This is the defining end-to-end test for Signed.md v1.0.**
