# Changelog

All notable changes to Signed.md are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Add each change under **Unreleased** as you merge it into `develop`. When `rc` is merged into `main`, the release workflow turns Unreleased into the new version's section.

## [Unreleased]

## [1.2.0] – 2026-11-26

Agents can be made to wait for a person's approval before sending, and the server starts about three times faster, which helps on platforms that stop idle containers.

### Added

- A new setting, "Sending by agents", in Settings. With "Need approval in the UI", an agent (an API key, over REST or MCP) can prepare a document but can't send it until a person approves that exact version on the document page. Sending fails with `DOCUMENT_NOT_APPROVED` until then, and any edit needs a new approval. People can still send from the web UI as before. The default is unchanged: agents send after the user approves in chat. The approval settings can now only be changed in the web UI, never with an API key.

- For platforms that stop idle containers: the server writes the next time its background worker has work (a job, an expiry or a reminder) to `DATA_DIR/next-work-at`, every minute and when it stops, so the platform can start it again in time. `cli.ts next-work` prints it. See "Stopping idle instances" in the self-hosting guide.

### Changed

- The server starts about three times faster and uses about a fifth of the CPU while starting. In the Docker image it now takes about 0.1 s instead of 0.3 s to accept requests, and on a slow CPU about 0.2 s instead of 1.3 s. This helps most on platforms that stop idle containers and start them again on the next request.
  - The Docker image runs a bundled server (`apps/server/bundle/main.js`, built with esbuild while the image builds) instead of loading about 1,200 files from source. Running from source (`pnpm start`, `pnpm demo`) is unchanged, and the CLI in the image still runs from source: `node apps/server/src/cli.ts`.
  - The REST API, MCP, PDF sealing, SMTP, webhook delivery, Word and PDF import, and the Postgres driver now load on first use instead of at start-up. The first API or MCP request after a start takes a few milliseconds longer.

## [1.1.1] – 2026-11-21

A small release for the verifier. `npx signed-md verify` now works from npm, and the package has a proper README.

### Fixed

- The `signed-md verify` command explains a missing or unreadable file, or a missing keys file, instead of printing a stack trace. It exits with code 2.
- The `signed-md` npm package now has a README.

## [1.1.0] – 2026-11-21

Signed.md now chases signatures for you. Signers who haven't signed get reminder emails with the same link as their first email, until they sign, decline, or the document expires.

### Before you upgrade

- Two database migrations run at start (`009_reminders`, `010_deadline_reminders`). They only add columns.
- Reminders stay off on existing installations until an owner turns them on in Settings → Account. New installations start with them on. Each document keeps its own setting.
- To reuse the same link, Signed.md now keeps each signer's link encrypted with the server secret (AES-256-GCM) until it stops working. Documents sent before the upgrade have no stored link: their first reminder sends a new one, and the old link stops working.

### Added

- Automatic reminders. Signers who haven't signed get a reminder every 3 business days (Monday to Friday in the document's timezone), while the deadline is at least 4 days away. They also get one 24 hours and one 1 hour before the deadline, on any day. Reminders reuse the link from the first email. Subjects are numbered: "REMINDER: …", "2ND REMINDER: …", and so on, and the last two end with "– expires in 24 hours" or "– expires in 1 hour".
- Reminders are an account default (Settings → Account) and a per-document setting (`reminders` in REST and MCP). The setting is part of the revision, so changing it needs a new preview.
- Each reminder is recorded in the evidence log as a `signer.reminded` event. The document page shows how many reminders each signer has had, and the API returns `reminders_sent` and `last_reminded_at` for each signer.
- The "only your signature is missing" email now carries the signer's link.

### Changed

- A manual resend counts as a reminder: its subject is numbered, and the next automatic reminder waits 3 business days. A resend still makes a new link and the old one stops working, so use it for lost or forwarded links, not as a nudge.

## [1.0.0] – 2026-11-20

The first public release of Signed.md: AI-native document signing you host yourself.

Agents draft agreements from approved Markdown templates through MCP or the REST API. People review, approve and send them, and signers sign in the browser on any device. Every completed agreement becomes a PDF/A-2b, sealed with PAdES and timestamped, plus a ZIP evidence package that anyone can check offline with `signed-md verify`.

Get started with Docker Compose (see [self-hosting](https://github.com/varops/signed-md/blob/main/docs/self-hosting.md)), or point your agent at the README and ask it to install Signed.md for you. Signed.md is open source under AGPL-3.0. [docs/legal.md](https://github.com/varops/signed-md/blob/main/docs/legal.md) explains how it fits ESIGN, UETA, eIDAS and UK law. It is not legal advice.

### Before you upgrade or install

- SMTP comes only from the `SMTP_*` environment variables. Without them, emails go to the in-app Outbox page.
- Logins time out after an hour of inactivity.
- "Powered by Signed.md" is shown on emails, signing pages and in the app by default.

### Added

- Markdown templates with template values (`{{$name:type}}`), signer fields (`{{signer.field:type}}`), front-matter limits and side-by-side columns.
- Template approval by an owner in the web UI only. Agents can draft templates but never approve them.
- Drafts with a revision hash over the text, values, signers and settings. Sending needs the exact revision a person approved.
- Signing in any order, in groups or all at once (order `0`), with reminders, expiry, resends and declines.
- A guided signing page: an intro with the e-signature disclosure, inline fields, Start/Next/Finish, typed or drawn signatures, a progress panel and an unsigned review copy to download.
- Completion: a PDF/A-2b, sealed with PAdES and timestamped (RFC 3161), with a certificate page, plus a ZIP package with a signed manifest and a hash-chained evidence log.
- The `signed-md verify` CLI to check a package offline.
- REST API with OpenAPI, an MCP server (Streamable HTTP), an agent skill served at `/skill.md`, and HMAC-signed webhooks.
- The Agents page: a setup prompt for any agent, MCP and REST details, API keys and the webhook.
- Teams with owner, administrator, member and viewer roles, invitations, deactivation and an activity log.
- Folders, search, filters and pagination for templates and documents.
- Branding: logo, banner colour, default message and contract font (STIX Two Text or Arimo).
- Word, OpenDocument, RTF and PDF import into Markdown.
- SQLite or PostgreSQL, local disk or S3 storage, SQLite backups to S3.
- Password reset by email, a signed login cookie and optional Google and Microsoft buttons for your own sign-in service.
- A mobile layout for the app and the signing page.
- A Docker image and Docker Compose file.
- One transition table for every status: documents, signers, template versions, team members, invitations, webhook deliveries and jobs. Each change checks the state it started from, so racing requests can't both succeed.

