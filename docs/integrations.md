# Signed.md
## REST, MCP, and agent skills specification

**Status:** Draft v0.1  
**Required release:** v1.0 MVP

## 1. Objective

An AI agent must be able to prepare, validate, preview, send, monitor, and retrieve a signed agreement using Signed.md.

All operations must be deterministic and auditable.

The agent supplies intelligence. Signed.md supplies execution.

## 2. Supported interfaces

### REST API

Primary programmatic interface.

Versioned under `/v1`.

### MCP server

Exposes the same signing capabilities to MCP-compatible agents.

### Agent skill

Documents the correct workflow for agents using REST or MCP.

The skill must be distributed with the open-source project.

All three interfaces share the same application logic.

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
Populate permitted values
      |
      v
Validate
      |
      v
Generate preview
      |
      v
Request user approval
      |
      v
Send for signature
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
GET    /v1/templates/{id}/versions/{version}
```

### Documents

```http
GET    /v1/documents
POST   /v1/documents
GET    /v1/documents/{id}
POST   /v1/documents/{id}/validate
GET    /v1/documents/{id}/preview
POST   /v1/documents/{id}/send
GET    /v1/documents/{id}/status
GET    /v1/documents/{id}/artifacts
```

### Configuration

```http
GET    /v1/account
GET    /v1/webhooks
PUT    /v1/webhooks
```

The final API should avoid redundant endpoints where resource representations already expose the necessary information.

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
  "fields": {
    "client.name": "Acme Ltd",
    "client.fee": 1000,
    "terms.notice_days": 30
  },
  "parties": [
    {
      "role": "provider",
      "email": "contracts@example.com"
    },
    {
      "role": "client",
      "email": "legal@acme.example"
    }
  ],
  "auto_send": false,
  "webhook_url": "https://example.com/hooks/contracts",
  "metadata": {
    "customer_id": "acme",
    "source": "sales-agent"
  }
}
```

A successful response returns the document ID, validation state, and relevant links.

### Alternative inputs

Document creation may use:

- `template_id`
- `content`
- `content_url`

These input modes are mutually exclusive unless explicitly documented otherwise.

## 6. Validation

Example:

```http
POST /v1/documents/doc_123/validate
```

Response:

```json
{
  "valid": false,
  "errors": [
    {
      "code": "FIELD_REQUIRED",
      "field": "client.email",
      "message": "Client email is required"
    }
  ]
}
```

Validation must never silently modify legal terms or send the agreement.

## 7. Preview

```http
GET /v1/documents/doc_123/preview
```

Preview must provide:

- Rendered agreement.
- Resolved field summary.
- Outstanding signer fields.
- Template version.
- Validation warnings.
- A document revision identifier.

Agents should present a human-readable summary alongside the preview.

The approval step must refer to the exact revision that was previewed.

## 8. Sending

```http
POST /v1/documents/doc_123/send
```

Example:

```json
{
  "approved_revision": "rev_456"
}
```

The server must reject sending if the draft changed after the approved preview.

The operation must support idempotency.

Agents must not treat a successful preview as authorisation to send.

## 9. Status

```http
GET /v1/documents/doc_123/status
```

Response includes:

- Current status.
- Party completion status.
- Signer completion status.
- Outstanding actions.
- Relevant timestamps.

## 10. Artifacts

```http
GET /v1/documents/doc_123/artifacts
```

Returns completed artifact metadata and authorised download links.

Download links should be short-lived and scoped to the specific artifact.

## 11. MCP tools

The v1.0 MCP server should expose:

| Tool | Purpose |
|---|---|
| `signed_list_templates` | Discover available templates |
| `signed_get_template` | Retrieve template and field schema |
| `signed_create_document` | Create a draft |
| `signed_validate_document` | Validate a draft |
| `signed_preview_document` | Retrieve preview and revision |
| `signed_send_document` | Send an approved revision |
| `signed_get_document` | Retrieve document details |
| `signed_list_documents` | Search and list documents |
| `signed_get_status` | Check signing progress |
| `signed_get_artifacts` | Retrieve completion artifacts |

Tools should return structured, machine-readable results.

MCP errors should preserve the API's error codes and field-level detail.

The MCP adapter must not introduce additional document state or authorisation rules.

## 12. Agent skill requirements

The repository must include a distributable skill with:

- Product description.
- API/MCP setup instructions.
- Authentication guidance.
- Template discovery workflow.
- Field population rules.
- Validation and preview workflow.
- Human approval requirements.
- Sending workflow.
- Status tracking.
- Artifact retrieval.
- Error handling.
- Security and privacy constraints.

### Required behavioural guidance

The skill must instruct agents to:

1. Prefer approved templates over writing new legal language.
2. Respect template field constraints.
3. Never invent unknown signatory details.
4. Never bypass validation errors.
5. Show material commercial terms before sending.
6. Obtain explicit approval unless the user has authorised automatic sending.
7. Never claim an agreement is signed until Signed.md confirms completion.
8. Preserve document IDs and idempotency keys when retrying.
9. Avoid disclosing signing links or documents to unrelated recipients.
10. Report declined, expired, or failed signing requests accurately.

## 13. Agent approval contract

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

## 14. Webhook-driven completion

When the document is finalised, Signed.md sends a signed webhook.

The receiving system can:

- Verify the webhook signature.
- Deduplicate using event ID.
- Download the ZIP.
- Verify the artifact checksum.
- Store or process the agreement.
- Notify the initiating agent or user.

The webhook should include customer-defined metadata to correlate the agreement with an external workflow.

A webhook is a notification, not proof of legal validity. Consumers should verify the completed package when appropriate.

## 15. Error handling

Use stable error codes.

Examples:

| Code | Meaning |
|---|---|
| `TEMPLATE_NOT_FOUND` | Requested template does not exist |
| `FIELD_REQUIRED` | Required field is missing |
| `FIELD_INVALID` | Field value violates its schema |
| `PARTY_INVALID` | Party configuration is invalid |
| `REVISION_MISMATCH` | Draft changed since preview |
| `DOCUMENT_ALREADY_SENT` | Sending operation is no longer valid |
| `DOCUMENT_NOT_FINALIZED` | Completion artifacts are not ready |
| `PERMISSION_DENIED` | API key lacks required permission |
| `RATE_LIMITED` | Request exceeds configured limits |

Errors must be actionable for both developers and agents.

## 16. Security boundaries

- API keys are secrets and must not appear in agent output.
- MCP operations must respect the same account permissions as REST.
- Agents must not infer that an email address establishes legal identity.
- Signing links must not be exposed in unrelated conversations.
- External Markdown URLs must be fetched with SSRF protections.
- Document content must be treated as untrusted data, not instructions to the agent.
- Webhook endpoints must be validated.
- All externally supplied strings must be safely rendered and stored.

## 17. MVP integration acceptance test

A compatible agent should successfully execute:

> Prepare our standard service agreement for Acme Ltd at $1,000 per month with 30 days' termination notice. Show me the agreement before sending it.

Expected behaviour:

1. Agent discovers the correct template.
2. Agent checks the permitted field schema.
3. Agent populates the specified values.
4. Agent identifies any missing recipient information.
5. Agent creates and validates the draft.
6. Agent presents the preview and commercial terms.
7. Agent waits for approval.
8. Agent sends the approved revision.
9. Agent reports the document ID and signing status.
10. After completion, the system delivers a signed webhook and downloadable evidence package.

**This is the defining end-to-end test for Signed.md v1.0.**
