import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ping } from "@signed-md/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Ctx } from "./context.ts";
import { createApi } from "./http/api.ts";
import { errorResponse } from "./http/errors.ts";
import { createMcpRoutes } from "./http/mcp.ts";
import { log } from "./log.ts";
import { avatarOrigin } from "./services/avatars.ts";
import { readLogo } from "./services/branding.ts";
import { certificatePem, pdfIdentity } from "./services/pdfsign.ts";
import { checkDownloadSignature, readArtifact } from "./services/finalize.ts";
import { createAdmin } from "./ui/admin.ts";
import { setBranding, setSourceUrl } from "./ui/layout.ts";
import { createSigningRoutes } from "./ui/signing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadAssets(): Record<string, { body: string; type: string }> {
  const dir = join(here, "..", "assets");
  return {
    "app.css": { body: readFileSync(join(dir, "app.css"), "utf8"), type: "text/css; charset=utf-8" },
    "app.js": { body: readFileSync(join(dir, "app.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "sign.js": { body: readFileSync(join(dir, "sign.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "theme.js": { body: readFileSync(join(dir, "theme.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    // Basecoat UI (MIT), prebuilt, served locally so no CDN is involved.
    "vendor/basecoat.css": {
      body: readFileSync(join(dirname(require.resolve("basecoat-css")), "basecoat.cdn.min.css"), "utf8"),
      type: "text/css; charset=utf-8",
    },
    "signature_pad.js": {
      body: readFileSync(join(dirname(require.resolve("signature_pad")), "signature_pad.umd.min.js"), "utf8"),
      type: "text/javascript; charset=utf-8",
    },
  };
}

export function createApp(ctx: Ctx) {
  const app = new Hono();
  const assets = loadAssets();
  setSourceUrl(ctx.config.sourceUrl);
  setBranding(ctx.config.branding);

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

  app.get("/health", async (c) => {
    const db = await ping(ctx.db);
    return c.json({ status: db ? "ok" : "degraded", database: db ? "ok" : "unreachable", version: "1.0.0" }, db ? 200 : 503);
  });

  app.get("/.well-known/signed-md-keys.json", async (c) => {
    c.header("cache-control", "public, max-age=300");
    const account = await ctx.db.selectFrom("accounts").select("name").limit(1).executeTakeFirst();
    const pdfCert = account ? certificatePem(pdfIdentity(ctx.config.dataDir, account.name).chain[0]!) : null;
    return c.json({ keys: [ctx.keys.info], pdf_signing_certificates: pdfCert ? [pdfCert] : [] });
  });

  // Bundled contract fonts (OFL), so the signing page matches the PDF.
  const FONT_FILES = new Set(["Inter-Regular.ttf", "Inter-Italic.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "SourceSerif4-Regular.otf", "SourceSerif4-It.otf", "SourceSerif4-Semibold.otf", "SourceSerif4-Bold.otf", "SourceSerif4-BoldIt.otf"]);
  app.get("/assets/fonts/:name", (c) => {
    const name = c.req.param("name");
    if (!FONT_FILES.has(name)) return c.notFound();
    c.header("content-type", name.endsWith(".otf") ? "font/otf" : "font/ttf");
    c.header("cache-control", "public, max-age=604800, immutable");
    return c.body(readFileSync(join(here, "..", "assets", "fonts", name)));
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

  app.route("/", createApi(ctx));
  app.route("/", createMcpRoutes(ctx));
  app.route("/", createSigningRoutes(ctx));
  app.route("/", createAdmin(ctx));

  return app;
}
