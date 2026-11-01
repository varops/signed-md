# Signed.md
## Technical architecture and implementation specification

**Status:** Draft v0.2  
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
     Database layer (SQLite or PostgreSQL) + local filesystem
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
- MCP endpoint.
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
      DATABASE_URL: sqlite:///data/signed.db
      STORAGE_PATH: /data/files
      PUBLIC_URL: https://sign.example.com
      SMTP_HOST: smtp.example.com

volumes:
  signed_data:
```

The database is selected by the `DATABASE_URL` scheme:

- `sqlite:///path/to/file.db` (default)
- `postgres://user:pass@host/db`

No code changes are needed to switch. This is illustrative configuration, not a final deployment contract.

## 4. Data model

The schema must work on both SQLite and PostgreSQL. Use portable column types: text IDs, ISO 8601 timestamps or integers, and JSON stored as text where needed.

Nothing is ever deleted. Records that can be hidden carry an `archived_at` timestamp.

### Account

Represents the company or installation owner.

v1.0 has one account.

Fields:

- ID
- Name
- Configuration (including default expiry and timezone)
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
- User ID (nullable in v1.0, required from v1.1)
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
- Created via (UI or API)
- Created timestamp
- Archived timestamp

### Template version

- ID
- Template ID
- Markdown source (including front matter)
- Field schema
- Content hash
- Created by (user or API key)
- Created timestamp
- Approval status: `pending_approval` or `approved`
- Approved by (user, never an API key)
- Approved timestamp

Template versions are immutable once created. Approval changes only the approval fields.

### Document

- ID
- Account ID
- Template version ID, nullable
- Markdown source
- Template values
- Resolved content snapshot
- Revision (hash of resolved content, values, and signers)
- Status
- Timezone
- Metadata
- Webhook URL override
- Source: `template` or `inline`
- Inline approval (user and timestamp), when the account requires it
- Approved revision and approved by
- Created timestamp
- Sent timestamp
- Expires timestamp
- Completed timestamp
- Revoked timestamp
- Archived timestamp

### Signer

- ID
- Document ID
- Key (the identifier used in placeholders, for example `client1`)
- Name
- Email
- Order (positive integer, default 1)
- Signing token hash
- Status: `pending`, `notified`, `viewed`, `signed`, `declined`
- Decline reason

There is no separate party table. Signers with the same `order` sign in parallel.

### Field

- ID
- Document ID
- Field key
- Kind: `value` (template value, `$` prefix) or `signer` (signer field)
- Type
- Signer key, for signer fields
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
- Previous event hash

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
- Locked until
- Last error

## 5. Document lifecycle

```text
draft ──send──> sent ──first signature──> partially_signed ──last signature──> signed ──package built──> finalized
                 |                              |
                 +------------------------------+----> declined
                 |                              |
                 +------------------------------+----> expired
                 |                              |
                 +------------------------------+----> revoked
```

| Status | Meaning |
|---|---|
| `draft` | Editable. Not visible to signers. |
| `sent` | Frozen. Links issued to the first signing group. |
| `partially_signed` | At least one signer has signed. |
| `signed` | All signers have signed. The PDF and package are being built. |
| `finalized` | The package is built and ready to download. Terminal. |
| `declined` | A signer declined. Terminal. |
| `expired` | The expiry passed before completion. Terminal. |
| `revoked` | The sender revoked the document. Terminal. |

Notes:

- Validation is an operation, not a status. Its result is tied to a revision.
- Editing a draft produces a new revision.
- Archiving is a flag (`archived_at`) on any document, in any status. It is not a status and does not change one.
- Drafts are not revoked; they are archived.
- The state machine must reject invalid transitions.

When a signing group completes, the next group (by `order`) is notified in the same transaction that records the last signature of the current group.

## 6. Markdown field engine

Parse placeholders into a typed field schema.

### Notation

```markdown
---
fields:
  $fee:
    label: Monthly fee
    minimum: "100.00"
  $notice_days:
    allowed_values: [30, 60, 90]
    default: 30
  client.start_date:
    label: Start date
---

# Service agreement

Client: {{$client_name:text}}

Monthly fee: {{$fee:currency(USD)}}

Notice period: {{$notice_days:number}} days

Start date: {{client.start_date:date}}

Client signature: {{client.signature:signature}}

Provider signature: {{provider.signature:signature}}
```

A placeholder has:

- Stable key.
- Kind: template value (`$` prefix) or signer field (`signer_key.field`).
- Type, with optional parameters (for example, `currency(USD)`).
- Optional constraints, defaults, labels, and `required` flag from front matter.

Rules:

- Template values are filled at creation. Signer fields are filled during signing by the signer whose key matches.
- A key that appears several times resolves to the same value.
- `\{{` is an escape and renders a literal `{{`.
- Front matter entries for keys that do not appear in the body are a validation error.
- Currency values are decimal strings. Number values may be integers or decimal strings. Dates are ISO 8601.

Field values are validated and normalised before rendering.

Never perform arbitrary code evaluation from templates.

Markdown rendering must sanitise unsafe HTML and external content.

## 7. Template authorisation

Templates define which values an agent can populate and within which limits. Constraints live in the template front matter (see §6).

The server enforces constraints.

An agent must not be able to bypass constraints by submitting a modified copy of an approved template and representing it as that template.

Template-based documents must retain their template version and provenance. Inline-content documents are marked as such and show no template provenance.

### Human approval

- Template versions created through REST or MCP start as `pending_approval`.
- The approve operation exists only in the web UI and requires a logged-in user session. From v1.1, that user must have the `owner` role. It is not exposed through REST or MCP, and API keys cannot call it.
- Creating a document from a `pending_approval` version fails with `TEMPLATE_NOT_APPROVED`.
- Approval is recorded as an event and included in the evidence of every document that uses the version.

### Inline documents

The account setting `inline_documents` is `allowed` (default), `needs_approval`, or `disabled`.

- `needs_approval`: sending fails with `DOCUMENT_NOT_APPROVED` until a user approves the exact revision in the UI.
- `disabled`: creating a document with `content` fails with `INLINE_DISABLED`.

## 8. Signing security

Signing links use high-entropy, expiring tokens.

Tokens are stored as hashes.

Signers can access only their authorised document and fields.

Signers in a later `order` group cannot access the document until their group is notified.

Revoking a document invalidates all of its signing tokens.

Capture affirmative consent to electronic signing.

Do not treat possession of an email link as proof of a signer's legal identity.

For documents requiring stronger assurance, additional identity verification will be necessary.

Use secure cookies, CSRF protections where applicable, rate limits, and appropriate session controls.

## 9. Evidence model

The completed agreement must preserve:

- Exact Markdown presented for signing.
- Resolved field values.
- Signer assignments and signing order.
- Approval record (approved revision and approved by).
- Consent records.
- Relevant events and timestamps.
- Signature representations.
- Final PDF hash.
- Package manifest.

The Markdown is the source of truth. The PDF is a rendition of it.

### Manifest signature

- The manifest lists every file in the package with its SHA-256.
- The manifest is serialised as canonical JSON (RFC 8785).
- It is signed with an installation-controlled Ed25519 key. The signature is detached.
- The public key is included in the package and published at `/.well-known/signed-md-keys.json`.

A separate verification command and a documented `openssl` procedure must verify hashes and signatures without contacting the originating server.

Key generation, storage, rotation, export, backup, and recovery are part of the security design. If the key is lost, existing packages still verify against the public key they contain, but the published trust anchor is lost. Backups must include the key.

### Trusted timestamps

Optionally, request an RFC 3161 timestamp over the manifest hash from a configured timestamp authority. Off by default.

A hash chain alone does not prove identity or establish that an event occurred at a particular real-world time.

## 10. Background processing

Use database-backed jobs for:

- Sending email.
- Notifying the next signing group.
- Delivering webhooks.
- Generating final packages.
- Retrying failed operations.
- Scheduled expiry.

The worker runs in the same process.

On SQLite, a single worker claims jobs with an atomic update. On PostgreSQL, workers claim jobs with `FOR UPDATE SKIP LOCKED`. The job table is the same in both.

Use bounded retries with backoff.

Ensure duplicate job execution does not cause duplicate signing transitions or duplicate completed agreements.

## 11. Webhooks

Support an account default and document-level override.

### Event catalogue

| Event | When | Release |
|---|---|---|
| `document.awaiting_last_signer` | A signature leaves exactly one signer unsigned. Includes that signer's key, name, and whether they have been notified yet. Not sent for single-signer documents. | v1.0 |
| `document.signed` | All signers signed | v1.0 |
| `document.finalized` | The PDF and package are ready | v1.0 |
| `document.declined` | A signer declined | v1.0 |
| `document.sent` | The document was sent | Later |
| `signer.notified` | A signer received a link (including later signing groups) | Later |
| `signer.viewed` | A signer opened the document | Later |
| `signer.signed` | One signer finished signing | Later |
| `document.expired` | The expiry passed | Later |
| `document.revoked` | The sender revoked the document | Later |

Example:

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
- Generate authorised download.

There is no delete operation.

Do not implement cloud storage backends until needed.

## 13. Rendering

### Markdown first

Until completion, there is no PDF. Preview and the signing page render HTML from the same parsed Markdown tree.

### PDF at completion

When the last signer signs, a background job:

1. Renders the signed Markdown and captured signatures to PDF.
2. Stores the PDF and records its SHA-256.
3. Builds and signs the package.
4. Moves the document to `finalized`.

The PDF is generated once and never regenerated. Re-rendering does not need to produce identical bytes, because verification uses the stored file and its hash.

HTML and PDF must come from the same parsed Markdown tree, so their content matches.

The final PDF includes signature representations, a signing summary page, and a reference to the verification evidence.

No external resources or fonts are fetched during rendering. Fonts are bundled in the container.

## 14. v1.1 migration

The account and user tables already exist in v1.0.

v1.1 introduces:

- Multiple users.
- Invitations.
- Roles.
- User permissions.
- Per-user API keys.
- Team activity.
- Template approval (and inline document approval) restricted to the `owner` role, still UI-only.

Existing installations must migrate without losing documents, keys, or signing evidence. Existing API keys are assigned to the original administrator.

## 15. Operational requirements

- Health endpoint.
- Structured logs.
- Database backup (SQLite online backup; `pg_dump` for PostgreSQL).
- Artifact and signing-key backup.
- Database migration system that runs on both SQLite and PostgreSQL.
- Configuration validation.
- Clear upgrade procedure.
- Recoverable background jobs.
- Graceful shutdown.
- Resource limits.
- Dependency and container security updates.

## 16. Testing priorities

1. Template parsing and validation.
2. Permission and signer isolation, including signing order and template approval (no API path can approve).
3. Document state transitions, including revoke and expiry.
4. Idempotent API operations.
5. Webhook retry and signature verification.
6. HTML and PDF content consistency.
7. Evidence verification.
8. Restart and crash recovery.
9. Migrations and backup restoration on SQLite and PostgreSQL.
10. Complete MCP-driven signing workflow.

CI runs the full test suite against both SQLite and PostgreSQL.

## 17. Engineering constraints

Avoid:

- Microservices.
- Mandatory cloud dependencies.
- Generative AI and external AI APIs.
- Separate MCP business logic.
- Heavy ORMs. Use a thin, typed query builder that supports SQLite and PostgreSQL.
- Database-specific SQL outside the job-claiming code.
- Complex orchestration.
- Heavy analytics infrastructure.

Prefer straightforward, testable modules with explicit boundaries.

## 18. Technology stack

| Layer | Choice | Reason |
|---|---|---|
| Language and runtime | TypeScript on Node.js 24 LTS | One language for server, UI, and verifier |
| HTTP and REST | Hono with `@hono/zod-openapi` | Small and fast; OpenAPI generated from the same schemas |
| Schemas | Zod | One schema drives REST validation, OpenAPI, and MCP tool inputs |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP at `/mcp`, API key as bearer token | Same process, same services; a stdio shim can follow if clients need it |
| Database | Kysely, with `better-sqlite3` (SQLite) and `pg` (PostgreSQL) dialects | Thin, typed, dialect-agnostic queries and migrations; switch by `DATABASE_URL` |
| Jobs | Own job table and in-process worker | No extra dependency |
| Markdown | unified / remark (mdast) with a custom placeholder plugin; YAML front matter | Parse once, render to HTML (with `rehype-sanitize`) and to PDF |
| PDF | Typst CLI in the container; mdast converted to Typst markup; fonts bundled | Small, fast, no network access |
| Crypto | Node built-in Ed25519; canonical JSON (RFC 8785) | Verifiable with standard tools, including `openssl` |
| Auth | argon2id (`@node-rs/argon2`), cookie sessions in the database, hashed prefixed API keys | Standard and simple |
| Email | Nodemailer (SMTP) | |
| Import (v1.2) | Firecrawl `pdf-inspector` (PDF) and `AnyDoc` (.docx and other formats), via Node bindings | Open source (MIT), fully local, fast; local OCR for scanned PDFs, on by default (model bundled in the image) |
| UI | React, Vite, Tailwind; admin SPA plus a separate lightweight signing page using `signature_pad` | Signing page stays fast on phones |
| Verifier | `signed-md verify agreement.zip`, also compiled to a single binary | Offline verification with no install |
| Tests | Vitest; Playwright for the end-to-end signing flow | Playwright runs the acceptance test |
| Container | `node:24-slim` with Typst and fonts, one volume at `/data` | Target under 250 MB |

### Repository layout

```text
apps/server        core wiring, REST, MCP, worker
apps/web           admin UI and signing page
packages/core      field engine, state machine, evidence
packages/db        Kysely schema, migrations, dialect selection
packages/verify    package verifier (library and CLI)
skills/signed-md   agent skill (SKILL.md)
```
