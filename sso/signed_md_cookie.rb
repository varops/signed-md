# Signed.md login cookie, for your own sign-in service. Server-side only: it needs COOKIE_HASH_KEY.
# Standard library only. See README.md.
require "base64"
require "openssl"

module SignedMdCookie
  COOKIE_NAME = "smd_session"
  MAX_AGE = 3600

  # The cookie value for a person you have signed in. now is a Unix time in seconds, for tests.
  def self.value(email, key, now = Time.now.to_i)
    encoded = Base64.urlsafe_encode64(email.strip.downcase, padding: false)
    body = "v1.#{encoded}.#{now + MAX_AGE}"
    "#{body}.#{OpenSSL::HMAC.hexdigest('SHA256', key, body)}"
  end

  # A complete Set-Cookie header value. domain is your COOKIE_DOMAIN, such as ".example.com".
  def self.set_cookie_header(email, key, domain = nil, now = Time.now.to_i)
    domain_part = domain ? " Domain=#{domain};" : ""
    "#{COOKIE_NAME}=#{value(email, key, now)}; Max-Age=#{MAX_AGE}; Path=/;#{domain_part} HttpOnly; Secure; SameSite=Lax"
  end
end
