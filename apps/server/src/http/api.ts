import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { SignedError } from "@signed-md/core";
import { now } from "@signed-md/db";
import type { MiddlewareHandler } from "hono";
import type { Actor, Ctx } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { accountView, getAccount, newWebhookSecret, updateAccount } from "../services/accounts.ts";
import { apiKeyActor } from "../services/auth.ts";
import * as docs from "../services/documents.ts";
import { listArtifacts } from "../services/finalize.ts";
import { requirePermission } from "../services/permissions.ts";
import * as tpl from "../services/templates.ts";
import * as folders from "../services/folders.ts";
import { errorResponse, statusFor } from "./errors.ts";
import { rateLimit } from "./ratelimit.ts";
import * as S from "./schemas.ts";

type Env = { Variables: { actor: Actor } };

const err = (description: string) => ({ content: { "application/json": { schema: S.ErrorSchema } }, description });
const ok = <T extends z.ZodTypeAny>(schema: T, description = "OK") => ({ content: { "application/json": { schema } }, description });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } }, required: true } });
const idParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const idemHeader = z.object({ "idempotency-key": z.string().max(200).optional().openapi({ description: "Retry safely: the same key and body return the original response." }) });
const security = [{ bearerAuth: [] }];
const common = { 401: err("Missing or invalid API key"), 429: err("Rate limited") };

export const WEBHOOK_EVENTS = ["document.awaiting_last_signer", "document.signed", "document.finalized", "document.declined"];

/** Bearer API key authentication. Session cookies are not accepted on the API. */
export function apiAuth(ctx: Ctx, via: "api" | "mcp"): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const actor = await apiKeyActor(ctx, key, via);
    if (!actor) throw new SignedError("UNAUTHENTICATED", "Missing or invalid API key. Send Authorization: Bearer <key>.");
    c.set("actor", actor);
    await next();
  };
}

/** Idempotency-Key support for POST requests. Same key + same body = same response. */
function idempotency(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || !key) return next();
    const actor = c.get("actor");
    const scope = `${actor.kind}:${actor.id}:${c.req.method} ${c.req.path}`;
    const reqHash = sha256(await c.req.text());
    const prior = await ctx.db.selectFrom("idempotency_keys").selectAll().where("key", "=", key).where("scope", "=", scope).executeTakeFirst();
    if (prior) {
      if (prior.request_hash !== reqHash) {
        throw new SignedError("INVALID_REQUEST", "This Idempotency-Key was already used with a different request body");
      }
      const saved = JSON.parse(prior.response) as { status: number; body: unknown };
      c.header("idempotent-replayed", "true");
      return c.json(saved.body as object, saved.status as 200);
    }
    await next();
    if (c.res.status < 500) {
      const text = await c.res.clone().text();
      await ctx.db
        .insertInto("idempotency_keys")
        .values({ key, scope, request_hash: reqHash, response: JSON.stringify({ status: c.res.status, body: JSON.parse(text || "null") }), created_at: now() })
        .onConflict((oc) => oc.columns(["key", "scope"]).doNothing())
        .execute();
    }
  };
}

export function createApi(ctx: Ctx) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ code: "INVALID_REQUEST" as const, field: i.path.join("."), message: i.message }));
        return c.json({ error: { code: "INVALID_REQUEST", message: "The request is not valid", details: issues } }, 400);
      }
    },
  });
  app.onError((e, c) => errorResponse(c, e));
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", description: "API key from Settings → API keys" });

  app.use("/v1/*", apiAuth(ctx, "api"));
  app.use("/v1/*", rateLimit({ windowMs: 60_000, max: 600, key: (c) => `api:${(c.get("actor") as Actor).id}` }));
  app.use("/v1/*", idempotency(ctx));

  // ---- Templates ----

  app.openapi(
    createRoute({ method: "get", path: "/v1/templates", tags: ["Templates"], summary: "List templates", security,
      request: { query: z.object({
        archived: z.enum(["true", "false"]).optional(),
        folder_id: z.string().optional().openapi({ description: 'A folder id, or "none" for templates in no folder.' }),
      }) },
      responses: { 200: ok(z.object({ data: z.array(S.TemplateSchema) })), ...common } }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json({ data: await tpl.listTemplates(ctx, { archived: q.archived === "true", ...(q.folder_id ? { folder: q.folder_id } : {}) }) }, 200);
    },
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/templates/{id}/move", tags: ["Templates"], summary: "File a template in a folder",
      description: "Owners and administrators only. Pass null to take it out of its folder.", security,
      request: { params: idParam, ...body(S.MoveSchema) }, responses: { 200: ok(S.TemplateSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await tpl.moveTemplate(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json").folder_id), 200),
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/templates", tags: ["Templates"], summary: "Create a template",
      description: "Templates created through the API start as pending_approval. A person must approve them in the web UI before documents can use them.",
      security, request: { ...body(S.TemplateCreateSchema), headers: idemHeader },
      responses: { 201: ok(S.TemplateSchema, "Created"), 422: err("Template has errors"), ...common } }),
    async (c) => c.json(await tpl.createTemplate(ctx, c.get("actor"), c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/templates/{id}", tags: ["Templates"], summary: "Get a template with its field schema",
      description: "Shows the latest approved version's source and fields, or the latest version if none is approved yet.",
      security, request: { params: idParam }, responses: { 200: ok(S.TemplateDetailSchema), 404: err("Not found"), ...common } }),
    async (c) => {
      const { id } = c.req.valid("param");
      const t = await tpl.getTemplate(ctx, id);
      const v = await tpl.getTemplateVersion(ctx, id, t.approved_version ?? undefined);
      return c.json({ ...t, source: v.source, fields: v.fields, version_shown: v.version }, 200);
    },
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/templates/{id}/versions", tags: ["Templates"], summary: "Create a new template version",
      description: "New versions start as pending_approval.", security,
      request: { params: idParam, ...body(S.TemplateVersionCreateSchema), headers: idemHeader },
      responses: { 201: ok(S.TemplateSchema, "Created"), 404: err("Not found"), 422: err("Template has errors"), ...common } }),
    async (c) => c.json(await tpl.addTemplateVersion(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/templates/{id}/versions/{version}", tags: ["Templates"], summary: "Get a template version", security,
      request: { params: z.object({ id: z.string(), version: z.coerce.number().int().min(1) }) },
      responses: { 200: ok(S.TemplateVersionDetailSchema), 404: err("Not found"), ...common } }),
    async (c) => {
      const { id, version } = c.req.valid("param");
      return c.json(await tpl.getTemplateVersion(ctx, id, version), 200);
    },
  );

  for (const archived of [true, false]) {
    app.openapi(
      createRoute({ method: "post", path: `/v1/templates/{id}/${archived ? "archive" : "unarchive"}`, tags: ["Templates"],
        summary: archived ? "Archive a template" : "Unarchive a template", security, request: { params: idParam },
        responses: { 200: ok(S.TemplateSchema), 404: err("Not found"), ...common } }),
      async (c) => c.json(await tpl.setTemplateArchived(ctx, c.get("actor"), c.req.valid("param").id, archived), 200),
    );
  }

  // ---- Documents ----

  app.openapi(
    createRoute({ method: "get", path: "/v1/documents", tags: ["Documents"], summary: "List documents", security,
      request: { query: z.object({
        status: z.string().optional(),
        archived: z.enum(["true", "false"]).optional(),
        mine: z.enum(["true", "false"]).optional().openapi({ description: "Only documents owned by the API key's user. Members always see only their own." }),
        q: z.string().max(200).optional().openapi({ description: "Search title, signer name, or email" }),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().optional().openapi({ description: "Cursor: next_before from the previous page" }),
        folder_id: z.string().optional().openapi({ description: 'A folder id, or "none" for documents in no folder.' }),
      }) },
      responses: { 200: ok(z.object({ data: z.array(S.DocumentSchema), next_before: z.string().nullable() })), ...common } }),
    async (c) => {
      const q = c.req.valid("query");
      const { folder_id, ...rest } = q;
      const { data, next_before } = await docs.listDocuments(ctx, c.get("actor"), { ...rest, archived: q.archived === "true", mine: q.mine === "true", ...(folder_id ? { folder: folder_id } : {}) });
      return c.json({ data, next_before }, 200);
    },
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents", tags: ["Documents"], summary: "Create a draft",
      description: "Creates a draft from an approved template or inline Markdown. Validation problems do not block creation; they are reported in `validation`. Use preview, then send the approved revision.",
      security, request: { ...body(S.CreateDocumentSchema), headers: idemHeader },
      responses: { 201: ok(S.DocumentSchema, "Created"), 403: err("Inline documents disabled"), 404: err("Template not found"), 409: err("Template not approved"), 422: err("Invalid"), ...common } }),
    async (c) => c.json(await docs.createDocument(ctx, c.get("actor"), c.req.valid("json") as docs.CreateDocumentInput), 201),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/documents/{id}", tags: ["Documents"], summary: "Get a document and its status", security,
      request: { params: idParam }, responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await docs.getDocument(ctx, c.get("actor"), c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({ method: "patch", path: "/v1/documents/{id}", tags: ["Documents"], summary: "Edit a draft",
      description: "Only drafts can be edited. Any change produces a new revision.", security,
      request: { params: idParam, ...body(S.UpdateDocumentSchema) },
      responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), 409: err("Not a draft"), ...common } }),
    async (c) => c.json(await docs.updateDocument(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json") as docs.UpdateDocumentInput), 200),
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents/{id}/validate", tags: ["Documents"], summary: "Validate a draft", security,
      request: { params: idParam }, responses: { 200: ok(S.ValidationSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await docs.validateDocument(ctx, c.get("actor"), c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/documents/{id}/preview", tags: ["Documents"], summary: "Preview a draft",
      description: "Returns the resolved agreement, the values, signer fields, signing order, and the revision. Show this to a person and send only the revision they approved.",
      security, request: { params: idParam }, responses: { 200: ok(S.PreviewSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await docs.previewDocument(ctx, c.get("actor"), c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents/{id}/send", tags: ["Documents"], summary: "Send an approved revision",
      description: "Fails with REVISION_MISMATCH if the draft changed since the approved preview.", security,
      request: { params: idParam, ...body(S.SendSchema), headers: idemHeader },
      responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), 409: err("Revision mismatch, already sent, or not approved"), 422: err("Invalid"), ...common } }),
    async (c) => c.json(await docs.sendDocument(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents/{id}/revoke", tags: ["Documents"], summary: "Revoke a sent document",
      description: "Signing links stop working immediately. Terminal: create a new document to correct it.", security,
      request: { params: idParam, ...body(S.RevokeSchema), headers: idemHeader },
      responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), 409: err("Not revocable"), ...common } }),
    async (c) => c.json(await docs.revokeDocument(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json").reason), 200),
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents/{id}/signers/{key}/resend", tags: ["Documents"], summary: "Resend a signing link",
      description: "Issues a new link to a notified signer who has not signed. The old link stops working.", security,
      request: { params: z.object({ id: z.string(), key: z.string() }) },
      responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), 409: err("Not possible in this state"), ...common } }),
    async (c) => {
      const { id, key } = c.req.valid("param");
      return c.json(await docs.resendToSigner(ctx, c.get("actor"), id, key), 200);
    },
  );

  for (const archived of [true, false]) {
    app.openapi(
      createRoute({ method: "post", path: `/v1/documents/{id}/${archived ? "archive" : "unarchive"}`, tags: ["Documents"],
        summary: archived ? "Archive a document" : "Unarchive a document", description: "Hides or restores the document in default lists. Does not change its status.",
        security, request: { params: idParam }, responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), ...common } }),
      async (c) => c.json(await docs.setDocumentArchived(ctx, c.get("actor"), c.req.valid("param").id, archived), 200),
    );
  }

  app.openapi(
    createRoute({ method: "post", path: "/v1/documents/{id}/move", tags: ["Documents"], summary: "File a document in a folder",
      description: "Works in any status: folders only organise, and moving doesn't change the revision. Pass null to take it out of its folder.",
      security, request: { params: idParam, ...body(S.MoveSchema) }, responses: { 200: ok(S.DocumentSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await docs.moveDocument(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json").folder_id), 200),
  );

  // ---- Folders ----

  app.openapi(
    createRoute({ method: "get", path: "/v1/folders", tags: ["Folders"], summary: "List folders", security,
      request: { query: z.object({ kind: z.enum(["template", "document"]) }) },
      responses: { 200: ok(z.object({ data: z.array(S.FolderSchema) })), ...common } }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json({ data: await folders.listFolders(ctx, q.kind) }, 200);
    },
  );

  app.openapi(
    createRoute({ method: "post", path: "/v1/folders", tags: ["Folders"], summary: "Create a folder",
      description: "Template folders need an owner or administrator. Document folders need permission to create documents.", security,
      request: { ...body(S.FolderCreateSchema), headers: idemHeader }, responses: { 201: ok(S.FolderSchema, "Created"), ...common } }),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(await folders.createFolder(ctx, c.get("actor"), b.kind, b.name), 201);
    },
  );

  app.openapi(
    createRoute({ method: "patch", path: "/v1/folders/{id}", tags: ["Folders"], summary: "Rename a folder", security,
      request: { params: idParam, ...body(S.FolderUpdateSchema) }, responses: { 200: ok(S.FolderSchema), 404: err("Not found"), ...common } }),
    async (c) => c.json(await folders.renameFolder(ctx, c.get("actor"), c.req.valid("param").id, c.req.valid("json").name), 200),
  );

  app.openapi(
    createRoute({ method: "delete", path: "/v1/folders/{id}", tags: ["Folders"], summary: "Delete a folder",
      description: "Everything in the folder moves to the top level. No template or document is deleted.", security,
      request: { params: idParam }, responses: { 200: ok(z.object({ folder: S.FolderSchema, moved: z.number().int().openapi({ description: "How many templates or documents moved to the top level" }) })), 404: err("Not found"), ...common } }),
    async (c) => c.json(await folders.deleteFolder(ctx, c.get("actor"), c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/documents/{id}/artifacts", tags: ["Documents"], summary: "Get completed artifacts",
      description: "Available once the document is finalized. Download links are short-lived.", security,
      request: { params: idParam }, responses: { 200: ok(z.object({ data: z.array(S.ArtifactSchema) })), 404: err("Not found"), 409: err("Not finalized"), ...common } }),
    async (c) => c.json({ data: await listArtifacts(ctx, c.get("actor"), c.req.valid("param").id) }, 200),
  );

  // ---- Configuration ----

  app.openapi(
    createRoute({ method: "get", path: "/v1/account", tags: ["Configuration"], summary: "Get account settings", security,
      responses: { 200: ok(S.AccountSchema), ...common } }),
    async (c) => c.json(accountView(await getAccount(ctx)), 200),
  );

  app.openapi(
    createRoute({ method: "get", path: "/v1/webhooks", tags: ["Configuration"], summary: "Get webhook configuration", security,
      responses: { 200: ok(S.WebhookConfigSchema), ...common } }),
    async (c) => {
      requirePermission(c.get("actor"), "settings.manage");
      const a = await getAccount(ctx);
      return c.json({ url: a.config.webhook_url, secret: a.config.webhook_secret, events: WEBHOOK_EVENTS }, 200);
    },
  );

  app.openapi(
    createRoute({ method: "put", path: "/v1/webhooks", tags: ["Configuration"], summary: "Set the account webhook URL", security,
      request: body(S.WebhookUpdateSchema), responses: { 200: ok(S.WebhookConfigSchema), 400: err("Invalid URL"), ...common } }),
    async (c) => {
      const { url, rotate_secret } = c.req.valid("json");
      const a = await updateAccount(ctx, c.get("actor"), { config: { webhook_url: url, ...(rotate_secret ? { webhook_secret: newWebhookSecret() } : {}) } });
      return c.json({ url: a.config.webhook_url, secret: a.config.webhook_secret, events: WEBHOOK_EVENTS }, 200);
    },
  );

  // Anything else under /v1 is a JSON 404, never a web page. (Template approval is deliberately not here.)
  app.all("/v1/*", () => {
    throw new SignedError("NOT_FOUND", "No such API endpoint. See /openapi.json.");
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Signed.md API",
      version: "1.0.0",
      description:
        "Markdown-native e-signatures. Create a draft, preview it, get human approval, send the approved revision, and download a verifiable package when it is finalized.",
    },
    servers: [{ url: ctx.config.publicUrl }],
  });

  return app;
}

export { statusFor };
