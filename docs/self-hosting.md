# Self-hosting Signed.md

Signed.md runs as one container with one data volume. It needs no other services. SMTP is optional.

## Quick start

```bash
docker compose up -d
```

Open `http://localhost:3000`, create the administrator, and you're ready. Without SMTP, emails appear on the **Outbox** page, so you can try the full flow first.

To run without Docker you need Node.js 22.18 or later, pnpm, and [Typst](https://github.com/typst/typst/releases) 0.13 on the `PATH`:

```bash
pnpm install
pnpm start
```

## Configuration

All settings are environment variables. Invalid values stop the server at start with a clear message.

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | The URL people use. Signing links, download links, and webhooks use it. Set it to your `https://` address. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `/data` in Docker, `./.data` otherwise | Database, signing keys, files, and the outbox. Back this up. |
| `DATABASE_URL` | `sqlite://$DATA_DIR/signed.db` | `sqlite:///path/file.db` or `postgres://user:pass@host:5432/db`. |
| `STORAGE_PATH` | `$DATA_DIR/files` | Where signed PDFs and packages are stored. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | – | SMTP server. You can also set SMTP in the UI (Settings), which takes precedence. |
| `TYPST_BIN` | `typst` | Path to the Typst binary. |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy so client IPs come from `X-Forwarded-For`. |
| `WORKER` | `1` | Set to `0` to run without the background worker (not recommended with one container). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. Logs are JSON, one line per event. |
| `ALLOW_INSECURE_WEBHOOKS` | – | Development only. Allows `http://` and private-network webhook targets. |

## Reverse proxy and HTTPS

Put Signed.md behind a proxy that terminates TLS (Caddy, nginx, Traefik). Set `PUBLIC_URL` to the `https://` address and `TRUST_PROXY=1`. With an `https://` `PUBLIC_URL`, session cookies are marked `Secure` and HSTS is sent.

Caddy example:

```text
sign.example.com {
  reverse_proxy localhost:3000
}
```

## PostgreSQL

Set `DATABASE_URL=postgres://...`. Nothing else changes. Migrations run automatically at start on both databases.

## Backups

Back up three things together: the database, the signing keys, and the files.

```bash
docker compose exec signed node apps/server/src/cli.ts backup /data/backups/$(date +%F)
```

This makes an online SQLite backup (safe while running) and copies `keys/` and `files/`. With PostgreSQL, use `pg_dump` for the database; the command still copies keys and files.

**The signing key matters.** Completed packages carry their public key, so they stay verifiable without it. But the published key at `/.well-known/signed-md-keys.json` is how others know a package came from you. If you lose `keys/`, you lose that link.

To restore, stop the container, put the backup back into the data volume (`signed.db`, `keys/`, `files/`), and start it again.

## Upgrades

Pull the new image and restart. Migrations run at start. Back up first.

## Headless setup

For automated installs:

```bash
node apps/server/src/cli.ts setup --account "Acme" --email admin@acme.com --password '...'
node apps/server/src/cli.ts api-key --label "Sales agent"
```

## Health

`GET /health` returns `200` with `{"status":"ok"}` when the database is reachable. The Docker image has a built-in health check.

## Security notes

- API keys are stored hashed. Signing tokens are 256-bit, single-signer, stored hashed, and expire with the document.
- Template approval is only possible in the web UI by a logged-in person. API keys and MCP cannot approve.
- Webhook targets must be public `https://` URLs. The resolved IP is checked at connect time, which blocks DNS rebinding.
- Markdown is sanitised. Raw HTML in templates is dropped. Values are escaped before rendering.
- Email access is not identity verification. The evidence and the PDF say so.
