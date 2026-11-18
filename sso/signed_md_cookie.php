<?php
// Signed.md login cookie, for your own sign-in service. Server-side only: it needs COOKIE_HASH_KEY.
// PHP 7.4+. See README.md.

const SIGNED_MD_COOKIE_NAME = 'smd_session';
const SIGNED_MD_MAX_AGE = 3600;

/** The cookie value for a person you have signed in. $now is a Unix time in seconds, for tests. */
function signed_md_cookie_value(string $email, string $key, ?int $now = null): string
{
    $now = $now ?? time();
    $encoded = rtrim(strtr(base64_encode(strtolower(trim($email))), '+/', '-_'), '=');
    $body = 'v1.' . $encoded . '.' . ($now + SIGNED_MD_MAX_AGE);
    return $body . '.' . hash_hmac('sha256', $body, $key);
}

/** Sends the cookie. $domain is your COOKIE_DOMAIN, such as ".example.com". Call before any output. */
function signed_md_set_cookie(string $email, string $key, ?string $domain = null): void
{
    setcookie(SIGNED_MD_COOKIE_NAME, signed_md_cookie_value($email, $key), [
        'expires' => time() + SIGNED_MD_MAX_AGE,
        'path' => '/',
        'domain' => $domain ?? '',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
