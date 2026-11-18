# Single sign-on helpers

Signed.md has no OAuth, OIDC or magic-link code of its own. Instead, it trusts a login cookie that any service you run can write. Sign people in however you like: Google, Microsoft, your company's identity provider, a magic link, a VPN check. Then write the cookie and send them back to Signed.md.

The files here write that cookie in TypeScript, Python, PHP, Go and Ruby. Each is one small function with no dependencies. Copy the one you need into your own sign-in service.

They need `COOKIE_HASH_KEY`, so they belong on your server. Never put the key in a browser or a mobile app: anyone holding it can log in as anyone.

## How it works

1. Set the same `COOKIE_HASH_KEY` on Signed.md and on your sign-in service. Use a long random value, at least 32 characters, for example from `openssl rand -hex 32`.
2. Run your sign-in service on the same domain as Signed.md, or a sibling subdomain. For example, Signed.md on `sign.example.com` and your service on `login.example.com`, with `COOKIE_DOMAIN=.example.com` on both.
3. Optional: set `OAUTH_GOOGLE_URL` or `OAUTH_MICROSOFT_URL` on Signed.md to your service. The login page then shows a "Continue with Google" or "Continue with Microsoft" button. The link gets `?next=<Signed.md address>`, so you know where to send people back.
4. Optional: set `ALLOW_EMAIL_LOGIN=false` on Signed.md, so your service is the only way in.
5. In your service, once you know who the person is, write the cookie with their email, and redirect to `next` (or to Signed.md's `/`).

Signed.md checks the signature and the expiry, and that the email belongs to an active user. People still join through an invitation: a valid cookie for an unknown email does nothing. Each page visit renews the cookie for another hour.

## Your responsibilities

- **Prove the email.** Signed.md trusts any cookie your key signed. Only write it for an email you have checked, for example a verified Google account.
- **Keep the key secret.** Store it like a password. Changing it logs everyone out.
- **Check `next` before redirecting.** Only redirect to your own Signed.md address. Otherwise your service can be used to send people to any website.
- **Use HTTPS.** The cookie is marked `Secure`, so browsers only send it over HTTPS.

## The cookie

```text
name:    smd_session
value:   v1.<base64url(lowercase email)>.<expires>.<signature>
         expires   = Unix time in seconds, one hour from now
         signature = HMAC-SHA256(COOKIE_HASH_KEY, "v1.<base64url(lowercase email)>.<expires>"), lowercase hex
         base64url has no "=" padding
flags:   Max-Age=3600; Path=/; Domain=<COOKIE_DOMAIN>; HttpOnly; Secure; SameSite=Lax
```

`v1` is a stable format. If it ever changes, a `v2` will be added next to it, and `v1` will keep working.

## Examples

TypeScript (Node 22 or later):

```ts
import { setCookieHeader } from "./signed-md-cookie.ts";

res.setHeader("Set-Cookie", setCookieHeader(verifiedEmail, process.env.COOKIE_HASH_KEY!, ".example.com"));
res.redirect(safeNext);
```

Python:

```python
from signed_md_cookie import set_cookie_header

response.headers["Set-Cookie"] = set_cookie_header(verified_email, os.environ["COOKIE_HASH_KEY"], ".example.com")
```

PHP:

```php
require 'signed_md_cookie.php';

signed_md_set_cookie($verifiedEmail, getenv('COOKIE_HASH_KEY'), '.example.com');
header('Location: ' . $safeNext);
```

Go:

```go
signedmdcookie.Set(w, verifiedEmail, os.Getenv("COOKIE_HASH_KEY"), ".example.com")
http.Redirect(w, r, safeNext, http.StatusFound)
```

Ruby:

```ruby
require_relative "signed_md_cookie"

response.headers["Set-Cookie"] = SignedMdCookie.set_cookie_header(verified_email, ENV.fetch("COOKIE_HASH_KEY"), ".example.com")
```

## Logging out

Signed.md's "Log out" deletes the cookie on its own domain setting. If your service keeps its own session too, end it there as well, or people will be signed straight back in.
