"""Signed.md login cookie, for your own sign-in service. Server-side only: it needs COOKIE_HASH_KEY.
Python 3.8+, standard library only. See README.md."""
import base64
import hashlib
import hmac
import time

COOKIE_NAME = "smd_session"
MAX_AGE = 3600


def cookie_value(email, key, now=None):
    """The cookie value for a person you have signed in. `now` is a Unix time in seconds, for tests."""
    now = int(time.time()) if now is None else now
    encoded = base64.urlsafe_b64encode(email.strip().lower().encode()).decode().rstrip("=")
    body = f"v1.{encoded}.{now + MAX_AGE}"
    return body + "." + hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest()


def set_cookie_header(email, key, domain=None, now=None):
    """A complete Set-Cookie header value. `domain` is your COOKIE_DOMAIN, such as ".example.com"."""
    domain_part = f" Domain={domain};" if domain else ""
    return f"{COOKIE_NAME}={cookie_value(email, key, now)}; Max-Age={MAX_AGE}; Path=/;{domain_part} HttpOnly; Secure; SameSite=Lax"
