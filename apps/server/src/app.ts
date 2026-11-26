import { readFileSync } from "node:fs";
import { VERSION } from "./version.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ping } from "@signed-md/db";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Ctx } from "./context.ts";
import { errorResponse } from "./http/errors.ts";
import { log } from "./log.ts";
import { ASSETS_DIR, ROOT_DIR } from "./paths.ts";
import { avatarOrigin } from "./services/avatars.ts";
import { readLogo } from "./services/branding.ts";
import { checkDownloadSignature, readArtifact } from "./services/finalize.ts";
import { createAdmin } from "./ui/admin.ts";
import { setHostedApp } from "./hosted.ts";
import { asset, logo, setAssetVersion, setBranding, setHosted, setSourceUrl, shell } from "./ui/layout.ts";
import { sha256 } from "./crypto.ts";
import { createSigningRoutes } from "./ui/signing.ts";

const require = createRequire(import.meta.url);

function loadAssets(): Record<string, { body: string; type: string }> {
  const dir = ASSETS_DIR;
  const brand = join(ROOT_DIR, "brand");
  const svg = (name: string) => ({ body: readFileSync(join(brand, name), "utf8"), type: "image/svg+xml" });
  const oat = dirname(require.resolve("@knadh/oat/package.json"));
  return {
    "app.css": { body: readFileSync(join(dir, "app.css"), "utf8"), type: "text/css; charset=utf-8" },
    "app.js": { body: readFileSync(join(dir, "app.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    // The Signed.md logo (light and dark), the square icon and the signing icon, from brand/.
    "logo-light.svg": svg("signedmd-light.svg"),
    "logo-dark.svg": svg("signedmd-dark.svg"),
    "icon.svg": svg("signedmd-icon.svg"),
    // The signing icon on signing pages when the account has no logo of its own.
    "sign-icon.svg": svg("signedmd-sign-icon.svg"),
    // Prefetch admin pages when the pointer rests on a link (Chrome and Edge; others ignore it).
    "speculation-rules.json": { body: readFileSync(join(dir, "speculation-rules.json"), "utf8"), type: "application/speculationrules+json" },
    "sign.js": { body: readFileSync(join(dir, "sign.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    // Oat UI (MIT, oat.ink), served locally so no CDN is involved.
    "vendor/oat.css": { body: readFileSync(join(oat, "oat.min.css"), "utf8"), type: "text/css; charset=utf-8" },
    "vendor/oat.js": { body: readFileSync(join(oat, "oat.min.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    // OverType (MIT, overtype.dev): the Markdown editor. A real textarea with highlighting on top.
    "vendor/overtype.js": { body: readFileSync(join(dirname(require.resolve("overtype")), "overtype.min.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "signature_pad.js": {
      body: readFileSync(join(dirname(require.resolve("signature_pad")), "signature_pad.umd.min.js"), "utf8"),
      type: "text/javascript; charset=utf-8",
    },
  };
}

/** A handler that builds a sub-app on the first request and passes every matching request to it. */
function lazyRoutes(build: () => Promise<{ fetch: Hono["fetch"] }>) {
  let routes: Promise<{ fetch: Hono["fetch"] }> | null = null;
  return async (c: Context) => {
    routes ??= build().catch((e: unknown) => {
      routes = null;
      throw e;
    });
    return (await routes).fetch(c.req.raw, c.env);
  };
}

export function createApp(ctx: Ctx) {
  const app = new Hono();
  const assets = loadAssets();
  setAssetVersion(sha256(Object.values(assets).map((a) => a.body).join("\n")).slice(0, 10));
  setSourceUrl(ctx.config.sourceUrl);
  setBranding(ctx.config.branding);
  setHosted(ctx.config.hosted);
  setHostedApp(ctx.config.hostedAppUrl, ctx.config.publicUrl);

  // Email previews set their own, stricter policy that allows same-origin framing.
  const EMAIL_PREVIEW = /^\/(outbox\/[A-Za-z0-9-]+\/html|settings\/branding\/preview)$/;
  const headers = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", avatarOrigin(ctx.config)],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "same-origin",
      strictTransportSecurity: ctx.config.publicUrl.startsWith("https://") ? "max-age=31536000" : false,
  });
  app.use("*", (c, next) => (EMAIL_PREVIEW.test(c.req.path) ? next() : headers(c, next)));

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    // Logged-in admin pages name the prefetch rules in a header: our CSP allows no inline scripts.
    // Keep every response out of search engines (pages, PDFs, JSON, the skill): noindex, but follow links.
    c.res.headers.set("x-robots-tag", "noindex, follow");
    if (c.res.headers.get("content-type")?.startsWith("text/html") && /^\/(documents|templates|team|activity|settings|outbox|agentic)(\/|$)/.test(c.req.path)) {
      c.res.headers.set("speculation-rules", `"${asset("speculation-rules.json")}"`);
    }
    if (!c.req.path.startsWith("/assets/")) {
      log.info("request", { method: c.req.method, path: c.req.path.replace(/\/s\/[^/]+/, "/s/…"), status: c.res.status, ms: Date.now() - start });
    }
  });

  // Templates and inline documents are capped at 500 KB; signatures at 300 KB each.
  app.use(
    "*",
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) => c.json({ error: { code: "INVALID_REQUEST", message: "Request body is too large (max 4 MB)", details: [] } }, 413),
    }),
  );

  app.onError((e, c) => errorResponse(c, e));

  // ACTIVE=false (hosted service, after an account is closed): no logins, no API or MCP, and no
  // signing links. Health, public keys and static assets still answer. Not documented on purpose:
  // self-hosters never need it.
  if (!ctx.config.active) {
    const OPEN = /^\/(health|\.well-known\/|assets\/)/;
    app.use("*", async (c, next) => {
      if (OPEN.test(c.req.path)) return next();
      const message = "This account is disabled.";
      if (c.req.path.startsWith("/v1/")) return c.json({ error: { code: "PERMISSION_DENIED", message, details: [] } }, 403);
      if (c.req.path === "/mcp") return c.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, 403);
      return c.html(shell({ title: "Account disabled" }, html`<div class="narrow auth">${logo("/login")}<div class="card"><h1>Account disabled</h1><p class="muted">${message}</p></div></div>`), 403);
    });
  }

  app.get("/health", async (c) => {
    const db = await ping(ctx.db);
    return c.json({ status: db ? "ok" : "degraded", database: db ? "ok" : "unreachable", version: VERSION }, db ? 200 : 503);
  });

  app.get("/.well-known/signed-md-keys.json", async (c) => {
    c.header("cache-control", "public, max-age=300");
    const account = await ctx.db.selectFrom("accounts").select("name").limit(1).executeTakeFirst();
    const { certificatePem, pdfIdentity } = await import("./services/pdfsign.ts");
    const pdfCert = account ? certificatePem(pdfIdentity(ctx.config.dataDir, account.name).chain[0]!) : null;
    return c.json({ keys: [ctx.keys.info], pdf_signing_certificates: pdfCert ? [pdfCert] : [] });
  });

  // Bundled fonts (OFL): the contract fonts, so the signing page matches the PDF, and the app's font.
  const FONT_FILES = new Set([
    ...["Regular", "Bold", "Italic", "BoldItalic"].flatMap((w) => [`STIXTwoText-${w}.ttf`, `Arimo-${w}.ttf`]),
    ...["400-normal", "400-italic", "500-normal", "600-normal"].map((w) => `ibm-plex-sans-latin-${w}.woff2`),
    "NothingYouCouldDo.ttf",
  ]);
  app.get("/assets/fonts/:name", (c) => {
    const name = c.req.param("name");
    if (!FONT_FILES.has(name)) return c.notFound();
    c.header("content-type", name.endsWith(".woff2") ? "font/woff2" : "font/ttf");
    c.header("cache-control", "public, max-age=604800, immutable");
    return c.body(readFileSync(join(ASSETS_DIR, "fonts", name)));
  });

  // The agent skill (skills/signed-md/SKILL.md), so agents can install it from this server.
  const skillPath = join(ROOT_DIR, "skills", "signed-md", "SKILL.md");
  app.get("/skill.md", (c) => {
    c.header("content-type", "text/markdown; charset=utf-8");
    c.header("cache-control", "public, max-age=3600");
    return c.body(readFileSync(skillPath, "utf8"));
  });

  // The home-screen icon (iOS asks for /apple-touch-icon.png on its own too). Full-bleed: iOS rounds the corners.
  const touchIcon = readFileSync(join(ROOT_DIR, "brand", "signedmd-apple-touch-icon.png"));
  app.get("/apple-touch-icon.png", (c) => {
    c.header("content-type", "image/png");
    c.header("cache-control", "public, max-age=86400");
    return c.body(new Uint8Array(touchIcon));
  });

  app.get("/assets/vendor/:name", (c) => {
    const a = assets[`vendor/${c.req.param("name")}`];
    if (!a) return c.notFound();
    c.header("content-type", a.type);
    c.header("cache-control", "public, max-age=86400");
    return c.body(a.body);
  });

  app.get("/assets/:name", (c) => {
    const a = assets[c.req.param("name")];
    if (!a) return c.notFound();
    c.header("content-type", a.type);
    c.header("cache-control", "public, max-age=3600");
    return c.body(a.body);
  });

  app.get("/branding/logo", async (c) => {
    const logo = await readLogo(ctx);
    if (!logo) return c.notFound();
    c.header("content-type", logo.contentType);
    c.header("cache-control", "public, max-age=86400");
    c.header("x-content-type-options", "nosniff");
    return c.body(new Uint8Array(logo.data));
  });

  app.get("/download/:id", async (c) => {
    const id = c.req.param("id");
    if (!checkDownloadSignature(ctx, id, c.req.query("exp") ?? "", c.req.query("sig") ?? "")) {
      return c.text("This download link is invalid or has expired.", 403);
    }
    const art = await readArtifact(ctx, id);
    if (!art) return c.notFound();
    c.header("content-type", art.contentType);
    c.header("content-disposition", `attachment; filename="${art.filename}"`);
    c.header("cache-control", "private, no-store");
    return c.body(new Uint8Array(art.data));
  });

  // The REST API and MCP load on their first request. Their libraries (Zod, OpenAPI, the MCP SDK)
  // are a large part of the start-up time, and a sleeping instance is woken by whatever comes first.
  const api = lazyRoutes(async () => (await import("./http/api.ts")).createApi(ctx));
  const mcp = lazyRoutes(async () => (await import("./http/mcp.ts")).createMcpRoutes(ctx));
  app.all("/v1/*", api);
  app.all("/openapi.json", api);
  app.all("/mcp", mcp);
  app.route("/", createSigningRoutes(ctx));
  app.route("/", createAdmin(ctx));

  return app;
}
