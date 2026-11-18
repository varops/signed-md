import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal S3-compatible server for tests: path-style PUT and GET of single objects.
 * It checks that requests carry an AWS Signature V4 header for the right key and region,
 * but does not recompute the signature.
 */
export async function startFakeS3(opts: { accessKeyId: string; region: string }) {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const requests: { method: string; key: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const key = decodeURIComponent(new URL(req.url!, "http://x").pathname.slice(1));
      requests.push({ method: req.method!, key });
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("AWS4-HMAC-SHA256 ") || !auth.includes(`Credential=${opts.accessKeyId}/`) || !auth.includes(`/${opts.region}/s3/aws4_request`)) {
        res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
        return;
      }
      if (req.method === "PUT") {
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers["content-type"] ?? "") });
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const o = objects.get(key);
        if (!o) res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        else res.writeHead(200, { "content-type": o.type }).end(o.body);
      } else {
        res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    objects,
    requests,
    keys: (prefix = "") => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
