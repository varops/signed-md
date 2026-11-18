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
| `STORAGE_PATH` | `$DATA_DIR/files` | Where signed PDFs and packages are stored, when S3 is not set. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | – | Store files in an S3 bucket instead of on disk. See [S3 storage](#s3-storage). |
| `S3_ENDPOINT` | AWS | For S3-compatible services (Cloudflare R2, Backblaze B2, MinIO, and others), the service's URL, such as `https://<account>.r2.cloudflarestorage.com`. |
| `S3_REGION` | `us-east-1` | The bucket's region. Some services need it to match exactly. |
| `S3_PREFIX` | – | Put everything under this folder in the bucket, such as `signed-md`. |
| `BACKUP_DB` | – | Set to `true` to also back up the SQLite database and keys to S3. See [Backups to S3](#backups-to-s3). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | – | SMTP server. Without it, emails go to the Outbox page. Check it with `node apps/server/src/cli.ts test-email you@example.com`. |
| `COOKIE_DOMAIN` | the current host | Share the login cookie with subdomains, such as `.example.com`. Must be `PUBLIC_URL`'s host or a parent of it. |
| `COOKIE_HASH_KEY` | derived from `keys/server-secret` | Key that signs the login cookie (at least 32 characters). Changing it logs everyone out. |
| `TYPST_BIN` | `typst` | Path to the Typst binary. |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy so client IPs come from `X-Forwarded-For`. |
| `WORKER` | `1` | Set to `0` to run without the background worker (not recommended with one container). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. Logs are JSON, one line per event. |
| `SOURCE_URL` | `https://github.com/varops/signed-md` | The "Source" link in the app. If you run a modified version, point it at your source code (AGPL-3.0 section 13). |
| `AVATAR_BASE_URL` | `https://unavatar.io` | Where avatars come from, when avatars are on (Settings → Branding). Point it at a CDN pull zone in front of unavatar.io. |
| `TSA_URL` | `http://timestamp.digicert.com` | RFC 3161 timestamp authority for the PDF seal and the evidence package. Only hashes are sent. Set to `off` to disable. |
| `PDF_SIGNING_KEY_FILE`, `PDF_SIGNING_CERT_FILE` | – | Your own certificate (PEM key, PEM certificate chain) for sealing PDFs. Without them, each installation creates a self-signed certificate. |
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

This makes an online SQLite backup (safe while running) and copies `keys/` and `files/`. With PostgreSQL, use `pg_dump` for the database; the command still copies keys and files. With S3 storage, files stay in the bucket and are not copied.

**The signing key matters.** Completed packages carry their public key, so they stay verifiable without it. But the published key at `/.well-known/signed-md-keys.json` is how others know a package came from you. If you lose `keys/`, you lose that link.

To restore, stop the container, put the backup back into the data volume (`signed.db`, `keys/`, `files/`), and start it again.

## S3 storage

Set `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (and `S3_ENDPOINT` for services other than AWS) to store signed PDFs, evidence packages and logos in a bucket instead of `STORAGE_PATH`. Files go under `<prefix>/files/`. Keep the bucket private. People download files through Signed.md, never straight from the bucket.

The key needs to read and write objects only. Signed.md never deletes files. Switching an existing installation to S3 doesn't move old files, so copy `files/` into the bucket under `<prefix>/files/` first.

## Backups to S3

With S3 set, `BACKUP_DB=true` backs up the SQLite database and the `keys/` folder to the same bucket:

- every minute, if anything changed, a compressed snapshot goes to `<prefix>/db/<time>.db.gz`, and `<prefix>/db/latest.json` points to it;
- once at start and once at shutdown, so a stopped container is always fully backed up;
- the keys go to `<prefix>/keys/keys.json` whenever they change.

At start, if the database or keys are missing on disk, Signed.md restores them from the latest backup. To move to a new server, start it with the same S3 settings and an empty data volume.

Signed.md never deletes old snapshots. Add a lifecycle rule to the bucket to expire `<prefix>/db/` after, say, 30 days. The keys file holds your private signing key, so keep the bucket private and the credentials safe.

`BACKUP_DB` works with SQLite only. With PostgreSQL, back up with `pg_dump` or your provider's backups. The startup log says whether backups are on.

## Upgrades

Pull the new image and restart. Migrations run at start. Back up first.

## Headless setup

For automated installs:

```bash
node apps/server/src/cli.ts setup --account "Acme" --name "Ada Lovelace" --email admin@acme.com --password '...'
node apps/server/src/cli.ts api-key --label "Sales agent" --user admin@acme.com
```

## Sealed PDFs and timestamps

Every completed PDF is PDF/A-2b and digitally sealed (PAdES), with a trusted timestamp. PDF readers show it as signed and flag any later change.

By default the seal uses a self-signed certificate created on first use (`keys/pdf-signing-key.pem` and `keys/pdf-signing-cert.pem`; back them up with the other keys). Adobe Reader then shows "signature is valid" for the content but the signer as not trusted. For the green check in Adobe Reader, buy a document-signing certificate from a provider on the [Adobe Approved Trust List](https://helpx.adobe.com/acrobat/kb/approved-trust-list1.html) and set `PDF_SIGNING_KEY_FILE` and `PDF_SIGNING_CERT_FILE`.

Timestamps come from DigiCert's free service by default. Use any RFC 3161 authority with `TSA_URL`, or `off` to disable. If the authority is unreachable, documents still complete without a timestamp.

## Avatars

Avatars are off by default. When you turn them on (Settings → Branding), emails and the admin UI show people's pictures from [unavatar.io](https://unavatar.io), with initials as a fallback. The lookup uses email addresses, so it shares them with unavatar.io, and email clients load the pictures from there.

unavatar.io rate-limits anonymous use. To cache avatars and keep requests off your server, put a CDN pull zone in front of it (for example Bunny, Cloudflare, or CloudFront):

1. Create a pull zone with origin `https://unavatar.io`.
2. Cache responses for a day or more.
3. Set `AVATAR_BASE_URL=https://your-zone.example-cdn.net`.

Signed.md builds URLs as `AVATAR_BASE_URL/<email>` and allows that host in its Content-Security-Policy.

## Health

`GET /health` returns `200` with `{"status":"ok"}` when the database is reachable. The Docker image has a built-in health check.

## Security notes

- API keys are stored hashed. Signing tokens are 256-bit, single-signer, stored hashed, and expire with the document.
- Template approval is only possible in the web UI by a logged-in person. API keys and MCP cannot approve.
- Webhook targets must be public `https://` URLs. The resolved IP is checked at connect time, which blocks DNS rebinding.
- Markdown is sanitised. Raw HTML in templates is dropped. Values are escaped before rendering.
- Email access is not identity verification. The evidence and the PDF say so.
