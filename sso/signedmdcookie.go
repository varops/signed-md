// Package signedmdcookie writes the Signed.md login cookie, for your own sign-in service.
// Server-side only: it needs COOKIE_HASH_KEY. Standard library only. See README.md.
package signedmdcookie

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	CookieName = "smd_session"
	MaxAge     = 3600
)

// Value is the cookie value for a person you have signed in. now is a Unix time in seconds.
func Value(email, key string, now int64) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(strings.ToLower(strings.TrimSpace(email))))
	body := "v1." + encoded + "." + strconv.FormatInt(now+MaxAge, 10)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(body))
	return body + "." + hex.EncodeToString(mac.Sum(nil))
}

// Set writes the cookie. domain is your COOKIE_DOMAIN, such as ".example.com", or "".
func Set(w http.ResponseWriter, email, key, domain string) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: Value(email, key, time.Now().Unix()), MaxAge: MaxAge, Path: "/",
		Domain: domain, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
}
