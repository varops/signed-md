import type { MiddlewareHandler } from "hono";
import { SignedError } from "@signed-md/core";

/** Small in-memory fixed-window rate limiter. Enough for a single-container install. */
export function rateLimit(opts: { windowMs: number; max: number; key: (c: Parameters<MiddlewareHandler>[0]) => string }): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    const now = Date.now();
    const k = opts.key(c);
    let h = hits.get(k);
    if (!h || h.reset < now) {
      h = { count: 0, reset: now + opts.windowMs };
      hits.set(k, h);
      if (hits.size > 10_000) for (const [kk, v] of hits) if (v.reset < now) hits.delete(kk);
    }
    h.count++;
    if (h.count > opts.max) {
      c.header("retry-after", String(Math.ceil((h.reset - now) / 1000)));
      throw new SignedError("RATE_LIMITED", "Too many requests. Try again shortly.");
    }
    await next();
  };
}

export function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  // Behind a reverse proxy, trust the first X-Forwarded-For hop only when configured.
  if (process.env.TRUST_PROXY === "1") {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}
