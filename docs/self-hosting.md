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
| `ALLOW_EMAIL_LOGIN` | `true` | Set to `false` to turn off email and password login, so people sign in only with the buttons below. Needs at least one of them. With it off, there are no passwords: invited people only enter their name, and `cli.ts setup` doesn't need `--password`. |
| `OAUTH_GOOGLE_URL`, `OAUTH_MICROSOFT_URL` | – | Show "Continue with Google" or "Continue with Microsoft" on the login page, next to the email login. See [Single sign-on](#single-sign-on). |
| `TYPST_BIN` | `typst` | Path to the Typst binary. |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy so client IPs come from `X-Forwarded-For`. |
| `WORKER` | `1` | Set to `0` to run without the background worker (not recommended with one container). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. Logs are JSON, one line per event. |
| `SOURCE_URL` | `https://github.com/varops/signed-md` | The "Source" link in the app. If you run a modified version, point it at your source code (AGPL-3.0 section 13). |
| `AVATAR_PROVIDER` | `unavatar` | Where avatars come from when they are on (Settings → Branding): `unavatar` or `gravatar`. See [Avatars](#avatars). |
| `UNAVATAR_DOMAIN`, `GRAVATAR_DOMAIN` | `unavatar.io`, `gravatar.com` | The provider's domain, or a CDN pull zone in front of it, such as `avatars.example.com`. |
| `UNAVATAR_TOKEN` | – | An unavatar.io publishable key (`pk_…`) for paid use, added to avatar links as `?token=`. Secret keys (`sk_…`) are refused, because the links are public. See [Avatars](#avatars). |
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

## Single sign-on

Signed.md doesn't talk to Google or Microsoft itself. Instead, it accepts a login cookie written by any service that holds `COOKIE_HASH_KEY`. Set `OAUTH_GOOGLE_URL` or `OAUTH_MICROSOFT_URL` to your own sign-in service, and the login page shows a button for it, with `?next=<where to return>` added to the link.

Your service signs the person in, then writes this cookie and redirects to `next` (check that `next` is your own domain):

```text
name:   smd_session
value:  v1.<base64url(email)>.<expires>.<HMAC-SHA256(COOKIE_HASH_KEY, "v1.<base64url(email)>.<expires>") as hex>
        expires is a Unix time in seconds, at most an hour ahead
domain: COOKIE_DOMAIN (your service must be on the same domain or a subdomain)
flags:  HttpOnly, Secure, SameSite=Lax, Path=/
```

Ready-made functions that write this cookie, in TypeScript, Python, PHP, Go and Ruby, are in [`sso/`](../sso/README.md).

Set `COOKIE_HASH_KEY` explicitly, so your service and Signed.md share it. The email must belong to an active user in Signed.md. The people still need to be invited first.

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

Avatars are off by default. When you turn them on (Settings → Branding), emails and the admin UI show people's pictures, with initials for anyone without one. Two providers are supported:

- **unavatar** (default): [unavatar.io](https://unavatar.io) looks people up across many services, so more people have a picture. It gets the email address. People without a picture get an initials image from [ui-avatars.com](https://ui-avatars.com), which unavatar fetches, so it also gets their name. Anonymous use is rate-limited and heavier use is paid. unavatar is open source, so you can also run your own.
- **gravatar**: [Gravatar](https://gravatar.com) only has people who created a Gravatar account. It gets a SHA-256 hash of the email address, not the address itself. It's free.

People's browsers and email clients load the pictures. Before sending an email, Signed.md also checks once a day per address that a picture exists, so emails never show a broken image.

To cache avatars, or to keep signers' IP addresses away from the provider, put a CDN pull zone in front of it (for example Bunny, Cloudflare or CloudFront):

1. Create a pull zone with origin `https://unavatar.io` or `https://gravatar.com`.
2. Pass the query string through to the origin (Signed.md adds `?fallback=…` or `?d=404&s=128`), and keep the `Content-Type` header. Each person's link never changes, so the initials images are cached too.
3. Cache pictures for about a week, and 404s for a day, so new and changed pictures appear.
4. Set `UNAVATAR_DOMAIN` or `GRAVATAR_DOMAIN` to the zone's domain.

For paid unavatar use, set `UNAVATAR_TOKEN` to a publishable key (`pk_…`). It appears in every avatar link, so anyone can see it. If you restrict the key to your domains, avatars in emails won't load, because email clients send no `Origin` or `Referer`. Behind a CDN, you can instead leave `UNAVATAR_TOKEN` unset and have the pull zone send an `x-api-key` header to unavatar, so no key is ever public.

Signed.md builds links as `https://<UNAVATAR_DOMAIN>/<email>?fallback=<ui-avatars.com link with the name>` or `https://<GRAVATAR_DOMAIN>/avatar/<sha256(email)>?d=404&s=128`, and allows that host in its Content-Security-Policy.

## Health

`GET /health` returns `200` with `{"status":"ok"}` when the database is reachable. The Docker image has a built-in health check.

## Security notes

- API keys are stored hashed. Signing tokens are 256-bit, single-signer, stored hashed, and expire with the document.
- Template approval is only possible in the web UI by a logged-in person. API keys and MCP cannot approve.
- Webhook targets must be public `https://` URLs. The resolved IP is checked at connect time, which blocks DNS rebinding.
- Markdown is sanitised. Raw HTML in templates is dropped. Values are escaped before rendering.
- Email access is not identity verification. The evidence and the PDF say so.
