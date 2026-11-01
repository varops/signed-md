# Signed.md

**Get documents signed. One API call.**

Signed.md is an open-source, self-hosted e-signature service built for humans, developers, and AI agents. Templates are plain Markdown. Agents prepare and send agreements through a REST API or MCP. Every completed agreement comes back as a package anyone can verify offline.

An independent open-source product by VarOps.

> **Status:** Pre-release. v1.0 is in active development. Not yet suitable for production legal agreements.

## Why Signed.md

- **Markdown templates.** No PDFs to edit, no signature boxes to drag around. Write the agreement in Markdown with typed placeholders.
- **Built for agents.** REST API, MCP server, and an agent skill ship from day one. The server enforces the approval flow, so an agent can only send the exact revision a human approved.
- **Approved terms stay approved.** Agents can draft templates, but only a human can approve them, in the web UI.
- **Verifiable packages.** Each completed agreement is a ZIP with the signed Markdown, a PDF, the evidence log, and a signed manifest. Verify it without contacting the server.
- **Runs anywhere.** One Docker container, SQLite, local disk, and SMTP. Switch to PostgreSQL with one setting.
- **Never deletes.** Documents and templates are revoked or archived, never deleted.
- **No generative AI.** Signed.md is not an AI product. The agent brings the intelligence; Signed.md does the execution.

## How it works

A template is plain Markdown with placeholders:

```markdown
# Service agreement

Client: {{$client_name:text}}
Monthly fee: {{$fee:currency(USD)}}
Notice period: {{$notice_days:number}} days
Plan: {{$plan:choice(standard|premium)}}

Client signature: {{client.signature:signature}}
Provider signature: {{provider.signature:signature}}
```

- `{{$name:type}}` is a template value, filled when the document is created.
- `{{signer.name:type}}` is a signer field, filled by that signer while signing.

Need limits? Add optional front matter. The server enforces it, so an agent can't send a fee below your minimum:

```yaml
---
fields:
  $fee:
    minimum: "100.00"
  $notice_days:
    allowed_values: [30, 60, 90]
---
```

The flow:

```text
create draft → validate → preview (revision) → human approves → send → sign → signed → finalized
```

Signers with the same `order` sign in parallel. The next group gets its link when the current group is done.

## Roadmap

| Release | Theme |
|---|---|
| v1.0 | Signing MVP: templates, signing, evidence packages, REST, MCP, agent skill |
| v1.1 | Teams: users, roles, owner-only template approval, Google / Microsoft / OIDC login |
| v1.2 | Integrations and review: PDF and Word import, S3 drop zone, delegated review |
| v2.0 | Enterprise |

## Documentation

- [Technical specification](docs/spec.md)
- [REST, MCP, and agent skills](docs/integrations.md)

## Stack

TypeScript on Node.js 24, Hono, Zod, Kysely (SQLite or PostgreSQL), unified/remark, Typst for PDF, React for the UI, and the official MCP SDK. See [spec §19](docs/spec.md#19-technology-stack).

## Licence

To be decided. AGPL-3.0 is the leading option.
