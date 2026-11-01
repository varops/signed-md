import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createApiKey } from "../src/services/auth.ts";
import { approveTemplateVersion } from "../src/services/templates.ts";
import { TEMPLATE, testContext } from "./helpers.ts";

describe("REST API", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());
  const app = createApp(ctx);
  const { key } = await createApiKey(ctx, user, "test");
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("requires an API key and rejects session-less access", async () => {
    const r = await app.request("/v1/templates");
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.code).toBe("UNAUTHENTICATED");
    expect((await app.request("/v1/templates", { headers: { authorization: "Bearer smd_nope" } })).status).toBe(401);
  });

  it("runs the document lifecycle with stable error codes", async () => {
    // Template created through the API is pending, and cannot be approved through the API.
    const t = (await (await call("POST", "/v1/templates", { name: "Services", source: TEMPLATE })).json()) as any;
    expect(t.versions[0].approval_status).toBe("pending_approval");
    expect((await call("POST", `/v1/templates/${t.id}/versions/1/approve`)).status).toBe(404);

    const body = {
      template_id: t.id,
      values: { client_name: "Acme", fee: "1000", notice_days: 30 },
      signers: [
        { key: "client", name: "Jane", email: "jane@acme.example" },
        { key: "provider", name: "Sam", email: "sam@x.example", order: 2 },
      ],
    };
    const blocked = await call("POST", "/v1/documents", body);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).error.code).toBe("TEMPLATE_NOT_APPROVED");
    await approveTemplateVersion(ctx, user, t.id, 1);

    // Schema errors list the exact field.
    const bad = await call("POST", "/v1/documents", { ...body, signers: [{ key: "client", name: "Jane", email: "not-an-email" }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.details[0].field).toBe("signers.0.email");

    // Idempotency: same key and body returns the same document.
    const a = await call("POST", "/v1/documents", body, { "idempotency-key": "acme-001" });
    const b = await call("POST", "/v1/documents", body, { "idempotency-key": "acme-001" });
    const docA = (await a.json()) as any;
    expect(a.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(((await b.json()) as any).id).toBe(docA.id);
    expect((await call("POST", "/v1/documents", { ...body, title: "x" }, { "idempotency-key": "acme-001" })).status).toBe(400);

    // Constraint violations are validation errors on the draft.
    const patched = (await (await call("PATCH", `/v1/documents/${docA.id}`, { values: { fee: "10" } })).json()) as any;
    expect(patched.validation.errors[0]).toMatchObject({ code: "FIELD_INVALID", field: "$fee" });
    await call("PATCH", `/v1/documents/${docA.id}`, { values: { fee: "1000" } });

    const preview = (await (await call("GET", `/v1/documents/${docA.id}/preview`)).json()) as any;
    expect(preview.valid).toBe(true);
    expect(preview.signing_order).toHaveLength(2);

    expect(((await (await call("POST", `/v1/documents/${docA.id}/send`, { approved_revision: "rev_x" })).json()) as any).error.code).toBe("REVISION_MISMATCH");
    const sent = await call("POST", `/v1/documents/${docA.id}/send`, { approved_revision: preview.revision, approved_by: "test" });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as any).status).toBe("sent");

    expect(((await (await call("PATCH", `/v1/documents/${docA.id}`, { title: "y" })).json()) as any).error.code).toBe("DOCUMENT_NOT_DRAFT");
    expect(((await (await call("GET", `/v1/documents/${docA.id}/artifacts`)).json()) as any).error.code).toBe("DOCUMENT_NOT_FINALIZED");

    const archived = (await (await call("POST", `/v1/documents/${docA.id}/archive`)).json()) as any;
    expect(archived.archived).toBe(true);
    expect(archived.status).toBe("sent");
    const list = (await (await call("GET", "/v1/documents")).json()) as any;
    expect(list.data.map((d: any) => d.id)).not.toContain(docA.id);
    const arch = (await (await call("GET", "/v1/documents?archived=true")).json()) as any;
    expect(arch.data.map((d: any) => d.id)).toContain(docA.id);

    const revoked = (await (await call("POST", `/v1/documents/${docA.id}/revoke`, { reason: "test" })).json()) as any;
    expect(revoked.status).toBe("revoked");
    expect((await call("DELETE", `/v1/documents/${docA.id}`)).status).toBe(404);
  });

  it("rejects private webhook targets unless allowed", async () => {
    const strict = await testContext({ ALLOW_INSECURE_WEBHOOKS: "" });
    const strictApp = createApp(strict.ctx);
    const k = (await createApiKey(strict.ctx, strict.user, "t")).key;
    const put = (url: string) =>
      strictApp.request("/v1/webhooks", { method: "PUT", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
    expect((await put("http://example.com/hook")).status).toBe(400);
    expect((await put("https://127.0.0.1/hook")).status).toBe(400);
    expect((await put("https://10.1.2.3/hook")).status).toBe(400);
    expect((await put("https://hooks.example.com/x")).status).toBe(200);
    await strict.ctx.close();
  });

  it("publishes OpenAPI, health, and the public key", async () => {
    const spec = (await (await app.request("/openapi.json")).json()) as any;
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/documents", "/v1/documents/{id}/send", "/v1/templates"]));
    expect((await app.request("/health")).status).toBe(200);
    const keys = (await (await app.request("/.well-known/signed-md-keys.json")).json()) as any;
    expect(keys.keys[0].kid).toBe(ctx.keys.info.kid);
  });
});
