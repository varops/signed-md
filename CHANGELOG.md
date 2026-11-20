# Changelog

All notable changes to Signed.md are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Add each change under **Unreleased** as you merge it into `develop`. When `rc` is merged into `main`, the release workflow turns Unreleased into the new version's section.

## [Unreleased]

The first public release.

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
