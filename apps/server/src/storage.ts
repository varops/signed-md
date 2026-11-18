import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { AwsClient } from "aws4fetch";
import type { S3Config } from "./config.ts";

/**
 * Artifact storage: signed PDFs, evidence packages, logos.
 * There is deliberately no delete operation.
 */
export interface Storage {
  /** Where files go, for logs: a folder or an s3:// URL. */
  readonly location: string;
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** Rejects when the file does not exist. */
  read(path: string): Promise<Buffer>;
}

/** Relative storage paths only: no absolute paths, no `..`. */
function checkPath(path: string): string {
  const clean = path.replace(/\\/g, "/");
  if (clean.startsWith("/") || clean.split("/").some((p) => p === ".." || p === "")) throw new Error(`Invalid storage path '${path}'`);
  return clean;
}

/** Local filesystem storage. Writes are atomic (temp file + rename). */
export class FsStorage implements Storage {
  readonly root: string;
  readonly location: string;

  constructor(root: string) {
    this.root = root;
    this.location = root;
    mkdirSync(root, { recursive: true });
  }

  private resolve(path: string): string {
    const full = normalize(join(this.root, checkPath(path)));
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage path '${path}'`);
    return full;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, data);
    await rename(tmp, full);
  }

  async read(path: string): Promise<Buffer> {
    return readFile(this.resolve(path));
  }
}

/**
 * A small S3 client: PUT, GET and HEAD of single objects. Works with AWS S3 and S3-compatible
 * services (Cloudflare R2, Backblaze B2, MinIO, Hetzner, and others).
 */
export class S3Bucket {
  readonly config: S3Config;
  readonly url: string;
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(config: S3Config) {
    this.config = config;
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: config.region });
    // A custom endpoint uses path-style URLs, which every S3-compatible service accepts.
    // AWS itself uses virtual-hosted URLs.
    this.base = config.endpoint
      ? `${config.endpoint}/${encodeURIComponent(config.bucket)}`
      : `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
    this.url = `s3://${config.bucket}/${config.prefix}`;
  }

  private objectUrl(key: string): string {
    const full = this.config.prefix + checkPath(key);
    return `${this.base}/${full.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, data: Uint8Array | string, contentType = "application/octet-stream"): Promise<void> {
    // A copy into a plain ArrayBuffer, which every fetch body type accepts.
    const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const res = await this.client.fetch(this.objectUrl(key), { method: "PUT", body, headers: { "content-type": contentType } });
    if (!res.ok) throw new Error(`S3 upload of '${key}' failed: ${res.status} ${await errorText(res)}`);
  }

  /** The object's bytes, or null when it does not exist. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.client.fetch(this.objectUrl(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 download of '${key}' failed: ${res.status} ${await errorText(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? res.statusText;
}

/** Storage in an S3 bucket, under `<prefix>files/`. */
export class S3Storage implements Storage {
  readonly location: string;
  private readonly bucket: S3Bucket;

  constructor(bucket: S3Bucket) {
    this.bucket = bucket;
    this.location = `${bucket.url}files/`;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    await this.bucket.put(`files/${checkPath(path)}`, data, contentTypeFor(path));
  }

  async read(path: string): Promise<Buffer> {
    const data = await this.bucket.get(`files/${checkPath(path)}`);
    if (!data) throw Object.assign(new Error(`ENOENT: no such file in storage, '${path}'`), { code: "ENOENT" });
    return data;
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".zip")) return "application/zip";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg")) return "image/jpeg";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
