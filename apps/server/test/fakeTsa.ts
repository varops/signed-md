import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OID } from "@signed-md/core/cms";
import { der, derDecode } from "@signed-md/core/der";
import { buildSignedData, loadSigningIdentity } from "../src/services/pdfsign.ts";

/** A minimal RFC 3161 timestamp authority for tests. Real deployments use TSA_URL (DigiCert by default). */
export async function startFakeTsa() {
  const dir = mkdtempSync(join(tmpdir(), "fake-tsa-"));
  mkdirSync(join(dir, "keys"));
  const identity = loadSigningIdentity(dir, "Test Timestamp Authority", {});
  let serial = 1;
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests++;
      const tsq = derDecode(new Uint8Array(Buffer.concat(chunks)));
      const imprint = tsq.children[1]!.children[1]!.value;
      const nonce = tsq.children.find((c, i) => i > 1 && c.tag === 0x02);
      const tstInfo = der.seq(
        der.int(1),
        der.oid("1.3.6.1.4.1.99999.1"),
        der.seq(der.seq(der.oid(OID.sha256), der.null()), der.octet(imprint)),
        der.int(serial++),
        der.generalizedTime(new Date()),
        ...(nonce ? [nonce.raw] : []),
      );
      const token = buildSignedData(identity, { eContentType: OID.tstInfo, digest: createHash("sha256").update(tstInfo).digest(), content: tstInfo }).contentInfo;
      res.writeHead(200, { "content-type": "application/timestamp-reply" }).end(Buffer.from(der.seq(der.seq(der.int(0)), token)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tsr`,
    requests: () => requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
