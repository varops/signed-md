# Signed.md
## Technical architecture and implementation specification

**Status:** Draft v0.1  
**Target:** v1.0 self-hosted MVP  
**Architecture:** Modular monolith

## 1. Architecture goals

Signed.md should run on a small VPS, be easy to understand, and require minimal maintenance.

The architecture must support future releases without prematurely implementing multi-tenancy, distributed infrastructure, or unnecessary service boundaries.

## 2. High-level architecture

```text
             Humans / Agents / Applications
                         |
        +----------------+----------------+
        |                |                |
      Web UI          REST API         MCP / Skills
        |                |                |
        +----------------+----------------+
                         |
                  Application core
                         |
      +------------------+------------------+
      |                  |                  |
   Templates         Documents           Signing
      |                  |                  |
      +------------------+------------------+
                         |
            SQLite + local filesystem
                         |
       +-----------------+-----------------+
       |                 |                 |
     SMTP             Webhooks         PDF / ZIP
```

All interfaces share one application core.

MCP must not reimplement business logic.

## 3. Deployment model

### v1.0

One container runs:

- HTTP server.
- Web UI.
- REST API.
- MCP endpoint or bundled MCP adapter.
- Background job processor.
- SQLite.
- Document rendering and packaging.

External dependencies:

- SMTP server for email delivery.
- Persistent local disk.

Example:

```yaml
services:
  signed:
    image: signedmd/signed:latest
    ports:
      - "3000:3000"
    volumes:
      - signed_data:/data
    environment:
      DATABASE_URL: /data/signed.db
      STORAGE_PATH: /data/files
      PUBLIC_URL: https://sign.example.com
      SMTP_HOST: smtp.example.com

volumes:
  signed_data:
```

This is illustrative configuration, not a final deployment contract.

## 4. Data model

### Account

Represents the company or installation owner.

v1.0 has one account.

Fields:

- ID
- Name
- Configuration
- Created timestamp

### User

v1.0 has one administrator.

Fields:

- ID
- Account ID
- Email
- Password hash
- Status

### API key

- ID
- Account ID
- Key hash
- Label
- Scope
- Created timestamp
- Revoked timestamp

### Template

- ID
- Account ID
- Name
- Description
- Current version
- Created timestamp

### Template version

- ID
- Template ID
- Markdown source
- Field schema
- Content hash
- Created timestamp

Template versions used by documents are immutable.

### Document

- ID
- Account ID
- Template version ID, nullable
- Markdown source or reference
- Resolved content snapshot
- Status
- Metadata
- Created timestamp
- Sent timestamp
- Completed timestamp

### Party

- ID
- Document ID
- Role
- Completion mode: any/all
- Status

### Signer

- ID
- Party ID
- Email
- Name
- Signing token reference
- Status

### Field

- ID
- Document ID
- Field key
- Type
- Assigned role
- Constraints
- Resolved value
- Completion status

### Event

- ID
- Document ID
- Event type
- Actor reference
- Timestamp
- Evidence metadata
- Previous event hash, where applicable

### Artifact

- ID
- Document ID
- Artifact type
- Storage path
- SHA-256
- Created timestamp

### Background job

- ID
- Job type
- Payload
- Status
- Attempts
- Next attempt timestamp
- Last error

## 5. Document lifecycle

```text
draft
  |
  v
validated
  |
  v
sent
  |
  +----> declined
  |
  +----> expired
  |
  v
partially_signed
  |
  v
completed
  |
  v
finalized
```

Validation is also an operation, not necessarily a permanent status. Editing a draft invalidates its prior validation result.

Finalization produces the evidence package.

The state machine must reject invalid transitions.

## 6. Markdown field engine

Parse placeholders into a typed field schema.

Example:

```markdown
# Service agreement

Client: {{client.name:text}}

Monthly fee: {{client.fee:currency(USD)}}

Notice period: {{terms.notice_days:number}}

Client signature: {{client.signature:signature}}
```

A placeholder has:

- Stable key.
- Type.
- Optional parameters.
- Optional constraints.
- Assigned party role, where applicable.

Field values are validated and normalised before rendering.

Never perform arbitrary code evaluation from templates.

Markdown rendering must sanitise unsafe HTML and external content.

## 7. Template authorisation

Templates may define fields that an agent can populate.

Example conceptual policy:

```json
{
  "fields": {
    "client.fee": {
      "type": "currency",
      "currency": "USD",
      "minimum": 100
    },
    "terms.notice_days": {
      "type": "number",
      "allowed_values": [30, 60, 90]
    }
  }
}
```

The server enforces constraints.

An agent must not be able to bypass constraints by submitting a modified copy of an approved template and representing it as that template.

Template-based documents must retain their template version and provenance.

## 8. Signing security

Signing links use high-entropy, expiring tokens.

Tokens must be stored securely, preferably as hashes.

Signers can access only their authorised document and fields.

Capture affirmative consent to electronic signing.

Do not treat possession of an email link as proof of a signer's legal identity.

For documents requiring stronger assurance, additional identity verification will be necessary.

Use secure cookies, CSRF protections where applicable, rate limits, and appropriate session controls.

## 9. Evidence model

The completed agreement must preserve:

- Exact document version presented for signing.
- Resolved field values.
- Signer assignments.
- Consent records.
- Relevant events and timestamps.
- Signature representations.
- Final PDF hash.
- Package manifest.

The manifest should be cryptographically signed using an installation-controlled signing key.

A separate verification command or documented procedure must verify hashes and signatures without contacting the originating server.

Key generation, storage, rotation, export, and recovery are part of the security design.

A hash chain alone does not prove identity or establish that an event occurred at a particular real-world time.

## 10. Background processing

Use SQLite-backed jobs for:

- Sending email.
- Delivering webhooks.
- Generating final packages.
- Retrying failed operations.
- Scheduled expiry.

The worker can run in the same process or container.

Use bounded retries with backoff.

Ensure duplicate job execution does not cause duplicate signing transitions or duplicate completed agreements.

## 11. Webhooks

Support an account default and document-level override.

Example completion event:

```json
{
  "id": "evt_123",
  "type": "document.finalized",
  "created_at": "2026-11-01T12:00:00Z",
  "data": {
    "document_id": "doc_123",
    "status": "finalized",
    "metadata": {
      "customer_id": "acme"
    },
    "artifact": {
      "url": "https://sign.example.com/download/...",
      "expires_at": "2026-11-02T12:00:00Z",
      "sha256": "..."
    }
  }
}
```

Requirements:

- HMAC signatures.
- Event IDs.
- At-least-once delivery.
- Exponential retry backoff.
- Delivery logs.
- Safe handling of retries.
- HTTPS for externally delivered webhooks.
- SSRF protection, including DNS and redirect checks.

## 12. Artifact storage

v1.0 uses local filesystem storage.

The application should isolate storage operations behind a small internal interface:

- Write artifact.
- Read artifact.
- Delete artifact.
- Generate authorised download.

Do not implement cloud storage backends until needed.

## 13. PDF rendering

The signing renderer and PDF renderer must produce materially consistent agreement content.

The final PDF should include completed signature representations and a reference to verification evidence.

Rendering must be deterministic enough to produce stable, verifiable artifacts.

External resources and fonts should not be fetched from arbitrary locations during rendering.

## 14. v1.1 migration

The account and user tables already exist in v1.0.

v1.1 introduces:

- Multiple users.
- Invitations.
- Roles.
- User permissions.
- Team activity.

Existing installations must migrate without losing documents, keys, or signing evidence.

## 15. Operational requirements

- Health endpoint.
- Structured logs.
- Database backup.
- Artifact backup.
- Database migration system.
- Configuration validation.
- Clear upgrade procedure.
- Recoverable background jobs.
- Graceful shutdown.
- Resource limits.
- Dependency and container security updates.

## 16. Testing priorities

1. Template parsing and validation.
2. Permission and signer isolation.
3. Document state transitions.
4. Idempotent API operations.
5. Webhook retry and signature verification.
6. PDF and ZIP consistency.
7. Evidence verification.
8. Restart and crash recovery.
9. SQLite migration and backup restoration.
10. Complete MCP-driven signing workflow.

## 17. Engineering constraints

Avoid:

- Microservices.
- Mandatory cloud dependencies.
- External AI APIs.
- Separate MCP business logic.
- Premature database abstraction layers.
- Complex orchestration.
- Heavy analytics infrastructure.

Prefer straightforward, testable modules with explicit boundaries.
