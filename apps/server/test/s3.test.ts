import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { backupPlan, startDbBackup } from "../src/backup.ts";
import { createContext } from "../src/bootstrap.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createDocument, previewDocument, sendDocument } from "../src/services/documents.ts";
import { listArtifacts, readArtifact } from "../src/services/finalize.ts";
import { submitSignature } from "../src/services/signing.ts";
import { listTemplates, createTemplate } from "../src/services/templates.ts";
import { drainJobs } from "../src/worker.ts";
import { startFakeS3 } from "./fakeS3.ts";
import { TEMPLATE, testContext } from "./helpers.ts";

const s3 = await startFakeS3({ accessKeyId: "AKTEST", region: "eu-central-1" });
afterAll(() => s3.close());
const S3_ENV = { S3_ENDPOINT: s3.url, S3_BUCKET: "tenants", S3_REGION: "eu-central-1", S3_ACCESS_KEY_ID: "AKTEST", S3_SECRET_ACCESS_KEY: "secret" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const meta = { ip: "203.0.113.7", user_agent: "vitest" };

describe("S3 settings", () => {
  it("needs credentials with a bucket, and normalises the prefix", () => {
    expect(() => loadConfig({ S3_BUCKET: "b" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...S3_ENV, S3_ENDPOINT: "https://s3.example.com/path" })).toThrow(ConfigError);
    expect(loadConfig({ ...S3_ENV, S3_PREFIX: "/acme" }).s3?.prefix).toBe("acme/");
    expect(loadConfig({ ...S3_ENV, S3_REGION: "" }).s3?.region).toBe("us-east-1");
    expect(loadConfig({}).s3).toBeNull();
  });

  it("only backs up the database with BACKUP_DB, S3 and SQLite", () => {
    expect(backupPlan(loadConfig({ ...S3_ENV })).on).toBe(false);
    expect(backupPlan(loadConfig({ BACKUP_DB: "true" }))).toMatchObject({ on: false, warn: true });
    expect(backupPlan(loadConfig({ ...S3_ENV, BACKUP_DB: "true", DATABASE_URL: "postgres://x@y/z" }))).toMatchObject({ on: false, warn: true });
    expect(backupPlan(loadConfig({ ...S3_ENV, BACKUP_DB: "true", DATA_DIR: "/tmp/x" })).on).toBe(true);
  });
});

describe("S3 file storage", async () => {
  const { ctx, user, dataDir } = await testContext({ ...S3_ENV, S3_PREFIX: "acme" });
  afterAll(() => ctx.close());

  it("stores signed documents and logos in the bucket, under the prefix", async () => {
    const doc = await createDocument(ctx, user, { content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "Ann", email: "ann@client.example" }] });
    await sendDocument(ctx, user, doc.id, { approved_revision: (await previewDocument(ctx, user, doc.id)).revision });
    await drainJobs(ctx);
    const { readdirSync, readFileSync } = await import("node:fs");
    const mail = readdirSync(join(dataDir, "outbox")).map((f) => JSON.parse(readFileSync(join(dataDir, "outbox", f), "utf8")) as { text: string }).at(-1)!;
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    await submitSignature(ctx, token, { consent: true, fields: { "a.signature": { kind: "drawn", image: PNG } } }, meta);
    await drainJobs(ctx);

    const files = s3.keys("tenants/acme/files/");
    expect(files.some((k) => k.endsWith("/signed.pdf"))).toBe(true);
    expect(files.some((k) => k.endsWith("/agreement.zip"))).toBe(true);
    expect(s3.objects.get(files.find((k) => k.endsWith(".pdf"))!)!.type).toBe("application/pdf");

    // Read back through the app, and attached to the completion email.
    const arts = await listArtifacts(ctx, user, doc.id);
    const pdf = await readArtifact(ctx, arts.find((a) => a.type === "pdf")!.id);
    expect(pdf!.data.subarray(0, 5).toString()).toBe("%PDF-");

    const { setLogo, readLogo } = await import("../src/services/branding.ts");
    await setLogo(ctx, user, Buffer.from(PNG.split(",")[1]!, "base64"));
    expect(s3.keys("tenants/acme/files/branding/")).toHaveLength(1);
    expect((await readLogo(ctx))?.contentType).toBe("image/png");
  }, 60_000);

  it("rejects paths that leave the storage area", async () => {
    await expect(ctx.storage.write("../other/x.pdf", "x")).rejects.toThrow(/Invalid storage path/);
    await expect(ctx.storage.write("/abs.pdf", "x")).rejects.toThrow(/Invalid storage path/);
    await expect(ctx.storage.read("docs/missing.pdf")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("database backups to S3", () => {
  const env = (dataDir: string) => ({
    ...S3_ENV,
    S3_PREFIX: "globex",
    BACKUP_DB: "true",
    DATA_DIR: dataDir,
    DATABASE_URL: `sqlite://${join(dataDir, "signed.db")}`,
    PUBLIC_URL: "http://localhost:3999",
    LOG_LEVEL: "error",
    TSA_URL: "off",
  });

  it("backs up only when something changed, then restores on a new server", async () => {
    const first = mkdtempSync(join(tmpdir(), "signedmd-backup-"));
    const ctx = await createContext(loadConfig(env(first)));
    const { setup } = await import("../src/services/accounts.ts");
    const { userId, accountId } = await setup(ctx, { accountName: "Globex", name: "Gail Owner", email: "gail@globex.example", password: "correct horse battery" });
    const owner = { kind: "user" as const, id: userId, accountId, label: "gail@globex.example", name: "Gail Owner", role: "owner" as const };

    const backup = startDbBackup(ctx, 3_600_000)!;
    await backup.run();
    const snapshots = () => s3.keys("tenants/globex/db/").filter((k) => k.endsWith(".db.gz"));
    expect(snapshots()).toHaveLength(1);
    expect(s3.keys("tenants/globex/keys/")).toEqual(["tenants/globex/keys/keys.json"]);

    await backup.run();
    expect(snapshots()).toHaveLength(1); // nothing changed

    await new Promise((r) => setTimeout(r, 5)); // distinct timestamp
    await createTemplate(ctx, owner, { name: "Services", source: TEMPLATE });
    await backup.stop(); // the last snapshot, as on shutdown
    expect(snapshots()).toHaveLength(2);
    const latest = JSON.parse(s3.objects.get("tenants/globex/db/latest.json")!.body.toString()) as { key: string };
    expect(`tenants/globex/${latest.key}`).toBe(snapshots().at(-1));
    expect(gunzipSync(s3.objects.get(snapshots().at(-1)!)!.body).subarray(0, 15).toString()).toBe("SQLite format 3");
    const kid = ctx.keys.info.kid;
    await ctx.close();

    // A new server with an empty disk and the same settings comes back with the data and keys.
    const second = mkdtempSync(join(tmpdir(), "signedmd-restore-"));
    const restored = await createContext(loadConfig(env(second)));
    expect((await listTemplates(restored)).map((t) => t.name)).toEqual(["Services"]);
    expect(restored.keys.info.kid).toBe(kid);
    await restored.close();
  }, 30_000);
});
