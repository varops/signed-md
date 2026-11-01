import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ping } from "@signed-md/db";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Ctx } from "./context.ts";
import { createApi } from "./http/api.ts";
import { errorResponse } from "./http/errors.ts";
import { createMcpRoutes } from "./http/mcp.ts";
import { log } from "./log.ts";
import { checkDownloadSignature, readArtifact } from "./services/finalize.ts";
import { createAdmin } from "./ui/admin.ts";
import { createSigningRoutes } from "./ui/signing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadAssets(): Record<string, { body: string; type: string }> {
  const dir = join(here, "..", "assets");
  return {
    "app.css": { body: readFileSync(join(dir, "app.css"), "utf8"), type: "text/css; charset=utf-8" },
    "app.js": { body: readFileSync(join(dir, "app.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "sign.js": { body: readFileSync(join(dir, "sign.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "signature_pad.js": {
      body: readFileSync(join(dirname(require.resolve("signature_pad")), "signature_pad.umd.min.js"), "utf8"),
      type: "text/javascript; charset=utf-8",
    },
  };
}

export function createApp(ctx: Ctx) {
  const app = new Hono();
  const assets = loadAssets();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "same-origin",
      strictTransportSecurity: ctx.config.publicUrl.startsWith("https://") ? "max-age=31536000" : false,
    }),
  );

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    if (!c.req.path.startsWith("/assets/")) {
      log.info("request", { method: c.req.method, path: c.req.path.replace(/\/s\/[^/]+/, "/s/…"), status: c.res.status, ms: Date.now() - start });
    }
  });

  app.onError((e, c) => errorResponse(c, e));

  app.get("/health", async (c) => {
    const db = await ping(ctx.db);
    return c.json({ status: db ? "ok" : "degraded", database: db ? "ok" : "unreachable", version: "1.0.0" }, db ? 200 : 503);
  });

  app.get("/.well-known/signed-md-keys.json", (c) => {
    c.header("cache-control", "public, max-age=300");
    return c.json({ keys: [ctx.keys.info] });
  });

  app.get("/assets/:name", (c) => {
    const a = assets[c.req.param("name")];
    if (!a) return c.notFound();
    c.header("content-type", a.type);
    c.header("cache-control", "public, max-age=3600");
    return c.body(a.body);
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
